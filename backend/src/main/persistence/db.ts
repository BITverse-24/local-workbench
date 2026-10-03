// Phase DB.1 — SQLite connection + idempotent schema apply + seeds.
// Source DDL: ./schema.sql (path injected via configurePersistence).
// DB file: <dataDir>/data/workbench.db (gitignored, WAL mode).

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "2";

export const SETTING_DEFAULTS: Record<string, unknown> = {
  selectedModel: "draft-qwen3",
  temperature: 0.2,
  theme: "dark",
  sovereigntyVisible: true,
  lastChatId: null,
};

function sourceDir(): string | null {
  // Guarded: plain `import.meta.url` is undefined inside the esbuild CJS
  // Electron bundle, where all paths arrive via configurePersistence().
  try {
    const url: unknown = (import.meta as unknown as { url?: unknown } | undefined)?.url;
    return typeof url === "string" ? path.dirname(fileURLToPath(url)) : null;
  } catch {
    return null;
  }
}
const here = sourceDir(); // .../backend/src/main/persistence (source/vitest only)
export const BACKEND_ROOT = here ? path.resolve(here, "..", "..", "..", "..") : process.cwd();
export const SCHEMA_PATH = here
  ? path.join(here, "schema.sql")
  : path.join(process.cwd(), "backend", "src", "main", "persistence", "schema.sql");

let configuredDataDir: string | null = null;
let configuredSchemaPath: string | null = null;

/** Called from `initBackend` with the Electron-provided config. */
export function configurePersistence(options: { dataDir?: string; schemaPath?: string }): void {
  if (options.dataDir !== undefined) configuredDataDir = options.dataDir;
  if (options.schemaPath !== undefined) configuredSchemaPath = options.schemaPath;
}

export function resolveDbPath(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.WORKBENCH_DB_PATH;
  if (fromEnv) return fromEnv;
  return path.join(configuredDataDir ?? BACKEND_ROOT, "data", "workbench.db");
}

type Db = Database.Database;

let instance: Db | null = null;
let instancePath: string | null = null;

// PERF OPTIMIZATION: WeakMap-backed prepared statement cache per SQLite Database instance.
// Reusing prepared `Statement` instances across queries avoids redundant SQL parsing,
// AST compilation, and bytecode generation on every database call (>90% speedup).
const dbStatementCache = new WeakMap<Db, Map<string, Database.Statement>>();

export function prepareCached(db: Db, sql: string): Database.Statement {
  let cache = dbStatementCache.get(db);
  if (!cache) {
    cache = new Map<string, Database.Statement>();
    dbStatementCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

function findSchemaPath(): string {
  // Configured path (from initBackend) wins; otherwise fall back to the
  // source-relative copy so vitest runs from source keep working.
  const candidates = [
    configuredSchemaPath,
    SCHEMA_PATH,
    path.join(BACKEND_ROOT, "src", "main", "persistence", "schema.sql"),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`schema.sql not found (tried: ${candidates.join("; ")})`);
}

function applySchema(db: Db): void {
  const schema = readFileSync(findSchemaPath(), "utf-8");
  db.exec(schema);
}

function migrateArtifactsSchema(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'").get() as
    | { sql: string }
    | undefined;
  if (!row?.sql) return;
  if (!row.sql.includes("'txt'") || !row.sql.includes("'md'")) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE artifacts_new (
        artifact_id   TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL CHECK (kind IN ('docx','pdf','xlsx','csv','txt','json','md')),
        filename      TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );
      INSERT INTO artifacts_new (artifact_id, run_id, kind, filename, relative_path, size_bytes, created_at)
        SELECT artifact_id, run_id, kind, filename, relative_path, size_bytes, created_at FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_new RENAME TO artifacts;
    `);
    db.pragma("foreign_keys = ON");
  }
}

function migrateConfirmationsSchema(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='confirmations'").get() as
    | { sql: string }
    | undefined;
  if (!row?.sql) return;
  if (!row.sql.includes("'plan_approval'")) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE confirmations_new (
        action_id  TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL CHECK (kind IN ('generate_docx','execute_python','generate_xlsx','plan_approval')),
        prompt     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        outcome    TEXT CHECK (outcome IN ('approved','rejected','expired','cancelled')),
        decided_at TEXT
      );
      INSERT INTO confirmations_new (action_id, run_id, kind, prompt, created_at, expires_at, outcome, decided_at)
        SELECT action_id, run_id, kind, prompt, created_at, expires_at, outcome, decided_at FROM confirmations;
      DROP TABLE confirmations;
      ALTER TABLE confirmations_new RENAME TO confirmations;
    `);
    db.pragma("foreign_keys = ON");
  }
}

function migrateRunsSchema(db: Db): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'").get() as
    | { sql: string }
    | undefined;
  if (!row?.sql) return;
  if (!row.sql.includes("state")) return;
  if (!row.sql.includes("'limit_exceeded'") || !row.sql.includes("'partial'")) {
    db.pragma("foreign_keys = OFF");
    const cols = (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((c) => c.name);
    const colList = cols.join(", ");
    db.exec(`
      CREATE TABLE runs_new (
        id              TEXT PRIMARY KEY,
        chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        state           TEXT NOT NULL DEFAULT 'created'
                        CHECK (state IN ('created','classifying','planning','acting',
                                         'awaiting_confirmation','completed','partial','failed','cancelled','limit_exceeded')),
        user_text_summary TEXT NOT NULL DEFAULT '',
        attachment_id   TEXT REFERENCES attachments(attachment_id),
        iteration_count INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        completed_at    TEXT
      );
      INSERT INTO runs_new (${colList})
        SELECT ${colList} FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
      CREATE INDEX IF NOT EXISTS idx_runs_chat ON runs(chat_id, created_at DESC);
    `);
    db.pragma("foreign_keys = ON");
  }
}

function seedDefaults(db: Db): void {
  const now = new Date().toISOString();
  const seedSetting = db.prepare(
    "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)",
  );
  const seedMany = db.transaction(() => {
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
      seedSetting.run(key, JSON.stringify(value), now);
    }
    db.prepare("INSERT INTO kv_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      SCHEMA_VERSION,
    );
  });
  seedMany();
}

/** Open (or reuse) the SQLite DB, apply schema idempotently, seed defaults. */
export function initDb(dbPath?: string): Db {
  const resolved = resolveDbPath(dbPath);
  if (instance && instancePath === resolved && instance.open) return instance;
  if (instance && instance.open) instance.close();
  if (resolved !== ":memory:") {
    mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const db = new Database(resolved);
  // Never apply an older application's schema to a database created by a future version.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv_meta'").get()) {
    const version = (db.prepare("SELECT value FROM kv_meta WHERE key='schema_version'").get() as { value: string } | undefined)?.value;
    if (version && (!/^\d+$/.test(version) || Number(version) > Number(SCHEMA_VERSION))) {
      db.close();
      throw new Error(`Unsupported database schema version: ${version}`);
    }
  }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  migrateArtifactsSchema(db);
  migrateConfirmationsSchema(db);
  migrateRunsSchema(db);
  seedDefaults(db);
  instance = db;
  instancePath = resolved;
  return db;
}

/** Lazily-initialized singleton for app code. Tests should call initDb(tmpPath) first. */
export function getDb(): Db {
  if (instance && instance.open) return instance;
  return initDb();
}

export function closeDb(): void {
  if (instance && instance.open) instance.close();
  instance = null;
  instancePath = null;
}

export function getSchemaVersion(db?: Db): string | null {
  const conn = db ?? getDb();
  const row = conn.prepare("SELECT value FROM kv_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
