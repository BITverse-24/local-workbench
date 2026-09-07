// Phase DB.1 — SQLite connection + idempotent schema apply + seeds.
// Source DDL: backend/DATABASE.md §2 (local copy: ./schema.sql).
// DB file: backend/data/workbench.db (gitignored, WAL mode).

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = "1";

export const SETTING_DEFAULTS: Record<string, unknown> = {
  selectedModel: "draft-qwen3",
  temperature: 0.2,
  theme: "dark",
  sovereigntyVisible: true,
  lastChatId: null,
};

const here = path.dirname(fileURLToPath(import.meta.url)); // .../backend/src/main/persistence
export const BACKEND_ROOT = path.resolve(here, "..", "..", "..", "..");
export const SCHEMA_PATH = path.join(here, "schema.sql");

export function resolveDbPath(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.WORKBENCH_DB_PATH;
  if (fromEnv) return fromEnv;
  return path.join(BACKEND_ROOT, "data", "workbench.db");
}

type Db = Database.Database;

let instance: Db | null = null;
let instancePath: string | null = null;

function findSchemaPath(): string {
  // Works both from source (vitest/ts) and from compiled dist output:
  // dist/src/main/persistence/*.js -> BACKEND_ROOT/src/main/persistence/schema.sql.
  const candidates = [
    SCHEMA_PATH,
    path.join(BACKEND_ROOT, "src", "main", "persistence", "schema.sql"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`schema.sql not found (tried: ${candidates.join("; ")})`);
}

function applySchema(db: Db): void {
  const schema = readFileSync(findSchemaPath(), "utf-8");
  db.exec(schema);
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
    db.prepare("INSERT OR IGNORE INTO kv_meta(key, value) VALUES ('schema_version', ?)").run(
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
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
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
