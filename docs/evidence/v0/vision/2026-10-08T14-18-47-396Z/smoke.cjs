var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// vision-smoke.ts
var import_node_crypto3 = require("node:crypto");
var import_node_fs10 = require("node:fs");
var import_node_path10 = __toESM(require("node:path"));

// backend/src/main/gateway/model-gateway.ts
var import_node_crypto = require("node:crypto");
var import_node_fs5 = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path6 = __toESM(require("node:path"), 1);

// backend/src/main/gateway/structured-data.ts
var import_json5 = __toESM(require("json5"), 1);
function stripHashComments(raw) {
  let output2 = "", quote = "", escaped = false, lineComment = false, blockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i], next = raw[i + 1];
    if (quote) {
      output2 += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (lineComment) {
      output2 += char;
      if (char === "\n" || char === "\r") lineComment = false;
    } else if (blockComment) {
      output2 += char;
      if (char === "*" && next === "/") {
        output2 += next;
        i++;
        blockComment = false;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      output2 += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      output2 += char;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      output2 += char;
    } else if (char === "#") {
      while (i + 1 < raw.length && raw[i + 1] !== "\n" && raw[i + 1] !== "\r") i++;
    } else output2 += char;
  }
  return output2;
}
function parseStructuredData(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    try {
      value = import_json5.default.parse(raw);
    } catch {
      value = import_json5.default.parse(stripHashComments(raw));
    }
  }
  const check = (item) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Non-finite JSON value");
    if (item !== null && typeof item === "object") Object.values(item).forEach(check);
  };
  check(value);
  return value;
}

// backend/src/main/gateway/registry.ts
var import_node_fs2 = require("node:fs");
var import_node_path2 = __toESM(require("node:path"), 1);
var import_zod = require("zod");

// backend/src/main/persistence/db.ts
var import_better_sqlite3 = __toESM(require("better-sqlite3"), 1);
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");
var SCHEMA_VERSION = "2";
var SETTING_DEFAULTS = {
  selectedModel: "primary-model",
  temperature: 0.2,
  theme: "dark",
  sovereigntyVisible: true,
  lastChatId: null
};
function sourceDir() {
  try {
    const url = void 0;
    return typeof url === "string" ? import_node_path.default.dirname((0, import_node_url.fileURLToPath)(url)) : null;
  } catch {
    return null;
  }
}
var here = sourceDir();
var BACKEND_ROOT = here ? import_node_path.default.resolve(here, "..", "..", "..", "..") : process.cwd();
var SCHEMA_PATH = here ? import_node_path.default.join(here, "schema.sql") : import_node_path.default.join(process.cwd(), "backend", "src", "main", "persistence", "schema.sql");
var configuredDataDir = null;
var configuredSchemaPath = null;
function resolveDbPath(override) {
  if (override) return override;
  const fromEnv = process.env.WORKBENCH_DB_PATH;
  if (fromEnv) return fromEnv;
  return import_node_path.default.join(configuredDataDir ?? BACKEND_ROOT, "data", "workbench.db");
}
var instance = null;
var instancePath = null;
var dbStatementCache = /* @__PURE__ */ new WeakMap();
function prepareCached(db, sql) {
  let cache = dbStatementCache.get(db);
  if (!cache) {
    cache = /* @__PURE__ */ new Map();
    dbStatementCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}
function findSchemaPath() {
  const candidates = [
    configuredSchemaPath,
    SCHEMA_PATH,
    import_node_path.default.join(BACKEND_ROOT, "src", "main", "persistence", "schema.sql")
  ].filter((c2) => typeof c2 === "string" && c2.length > 0);
  for (const c2 of candidates) {
    if ((0, import_node_fs.existsSync)(c2)) return c2;
  }
  throw new Error(`schema.sql not found (tried: ${candidates.join("; ")})`);
}
function applySchema(db) {
  const schema = (0, import_node_fs.readFileSync)(findSchemaPath(), "utf-8");
  db.exec(schema);
}
function migrateArtifactsSchema(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'").get();
  if (!row?.sql) return;
  const columns = db.prepare("PRAGMA table_info(artifacts)").all();
  const hasSha256 = columns.some((column) => column.name === "sha256");
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
        sha256        TEXT,
        created_at    TEXT NOT NULL
      );
      INSERT INTO artifacts_new (artifact_id, run_id, kind, filename, relative_path, size_bytes, sha256, created_at)
        SELECT artifact_id, run_id, kind, filename, relative_path, size_bytes, ${hasSha256 ? "sha256" : "NULL"}, created_at FROM artifacts;
      DROP TABLE artifacts;
      ALTER TABLE artifacts_new RENAME TO artifacts;
    `);
    db.pragma("foreign_keys = ON");
  } else if (!hasSha256) {
    db.exec("ALTER TABLE artifacts ADD COLUMN sha256 TEXT");
  }
}
function migrateConfirmationsSchema(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='confirmations'").get();
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
function migrateRunsSchema(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'").get();
  if (!row?.sql) return;
  if (!row.sql.includes("state")) return;
  if (!row.sql.includes("'limit_exceeded'") || !row.sql.includes("'partial'")) {
    db.pragma("foreign_keys = OFF");
    const cols = db.prepare("PRAGMA table_info(runs)").all().map((c2) => c2.name);
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
function seedDefaults(db) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const seedSetting = db.prepare(
    "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES (?, ?, ?)"
  );
  const seedMany = db.transaction(() => {
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
      seedSetting.run(key, JSON.stringify(value), now);
    }
    db.prepare("INSERT INTO kv_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      SCHEMA_VERSION
    );
  });
  seedMany();
}
function initDb(dbPath) {
  const resolved = resolveDbPath(dbPath);
  if (instance && instancePath === resolved && instance.open) return instance;
  if (instance && instance.open) instance.close();
  if (resolved !== ":memory:") {
    (0, import_node_fs.mkdirSync)(import_node_path.default.dirname(resolved), { recursive: true });
  }
  const db = new import_better_sqlite3.default(resolved);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv_meta'").get()) {
    const version = db.prepare("SELECT value FROM kv_meta WHERE key='schema_version'").get()?.value;
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
function getDb() {
  if (instance && instance.open) return instance;
  return initDb();
}

// backend/src/main/persistence/settings-store.ts
function getSetting(key) {
  const db = getDb();
  const row = prepareCached(db, "SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return void 0;
  return JSON.parse(row.value);
}

// backend/src/main/gateway/registry.ts
var entry = import_zod.z.object({ id: import_zod.z.string().min(1), taskTypes: import_zod.z.array(import_zod.z.enum(["vision", "draft", "code"])).min(1).optional(), runtime: import_zod.z.enum(["mlx-lm", "llama-server", "ollama"]), baseUrl: import_zod.z.string().url(), model: import_zod.z.string().min(1), capabilities: import_zod.z.array(import_zod.z.enum(["text", "image-input", "structured-output", "code-generation"])), requestTimeoutMs: import_zod.z.number().int().positive().max(6e5), healthPath: import_zod.z.literal("/models"), enabled: import_zod.z.boolean(), fallbackOnly: import_zod.z.boolean().optional(), toolCallingFormat: import_zod.z.enum(["native", "json"]).optional(), temperature: import_zod.z.number().min(0).max(2).optional(), contextLength: import_zod.z.number().int().positive().max(128e3).optional(), maxOutputTokens: import_zod.z.number().int().positive().max(128e3).optional() }).strict();
var config = import_zod.z.object({ $comment: import_zod.z.string().optional(), models: import_zod.z.array(entry).min(1) }).strict();
var configuredModelsPath = null;
function defaultModelsPath() {
  if (configuredModelsPath) return configuredModelsPath;
  const fromEnv = process.env.WORKBENCH_MODELS_PATH;
  if (fromEnv) return import_node_path2.default.resolve(fromEnv);
  return import_node_path2.default.resolve(process.cwd(), "config", "models.json");
}
function sanitizeHost(host) {
  let cleaned = (host || "").trim();
  cleaned = cleaned.replace(/^https?:\/\//i, "");
  cleaned = cleaned.replace(/\/.*$/, "");
  if (cleaned.includes(":") && !cleaned.includes("[")) {
    const parts = cleaned.split(":");
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      cleaned = parts[0];
    }
  }
  return cleaned || "127.0.0.1";
}
function buildRegistryFromRows(rows) {
  let profiles = [];
  try {
    profiles = Array.from(loadRegistry().values());
  } catch {
  }
  const eligible = rows.filter((row) => row.role !== "embedding" && row.modelName?.trim());
  const primaryRows = eligible.filter((row) => row.role === "primary");
  const candidates = primaryRows.length ? primaryRows : [eligible.find((row) => row.role === "draft") ?? eligible[0]].filter(Boolean);
  const seen = /* @__PURE__ */ new Set();
  const primaryEntries = candidates.filter((row) => {
    const key = `${sanitizeHost(row.host)}:${row.port || 11434}/${row.modelName.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row, index) => {
    const host = sanitizeHost(row.host);
    const port = row.port || 11434;
    const baseUrl = `http://${host}:${port}/v1`;
    const profile = profiles.find((candidate) => candidate.model === row.modelName && candidate.baseUrl.replace(/\/$/, "") === baseUrl);
    return {
      id: index === 0 ? "primary-model" : `model-${index + 1}`,
      runtime: "ollama",
      baseUrl,
      model: row.modelName,
      capabilities: profile?.capabilities ?? ["text", "image-input", "structured-output", "code-generation"],
      requestTimeoutMs: 3e5,
      healthPath: "/models",
      enabled: true,
      contextLength: row.contextLength || 8192,
      maxOutputTokens: profile?.maxOutputTokens ?? (row.contextLength || 8192),
      ...profile?.toolCallingFormat ? { toolCallingFormat: profile.toolCallingFormat } : {},
      ...profile?.temperature !== void 0 ? { temperature: profile.temperature } : {}
    };
  });
  const auxiliary = profiles.filter((profile) => profile.fallbackOnly && !primaryEntries.some((primary) => primary.id === profile.id || primary.model === profile.model && primary.baseUrl === profile.baseUrl));
  return [...primaryEntries, ...auxiliary];
}
function defaultLocalRegistry() {
  const entries = buildRegistryFromRows([
    { role: "draft", modelName: "qwen3:8b", host: "127.0.0.1", port: 11434, contextLength: 32768 }
  ]);
  return new Map(entries.map((e) => [e.id, e]));
}
function loadProductionRegistryEntriesFromDb(dbModels) {
  let rows = dbModels;
  if (!rows) {
    try {
      rows = getSetting("configured_models");
    } catch {
    }
  }
  if (rows && Array.isArray(rows) && rows.length > 0) {
    return buildRegistryFromRows(rows);
  }
  try {
    return Array.from(loadRegistry().values());
  } catch {
    return Array.from(defaultLocalRegistry().values());
  }
}
function loadRegistry(filePath) {
  const resolved = filePath ?? defaultModelsPath();
  let text;
  try {
    text = (0, import_node_fs2.readFileSync)(resolved, "utf8");
  } catch {
    throw new Error(`models.json not found (tried: ${resolved})`);
  }
  const parsed = config.parse(JSON.parse(text));
  return new Map(parsed.models.map((model) => [model.id, model]));
}
function resolveModel(registry2, modelId, taskType) {
  const model = registry2.get(modelId);
  if (!model || !model.enabled) throw new Error(`model unavailable: ${modelId}`);
  return model;
}

// backend/src/main/gateway/normalizer.ts
function extractJsonFromText(text) {
  if (typeof text !== "string" || !text.includes("{")) return void 0;
  const candidates = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      let depth = 0;
      for (let j = i; j < text.length; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") {
          depth--;
          if (depth === 0) {
            candidates.push(text.slice(i, j + 1));
            break;
          }
        }
      }
    }
  }
  let fallbackObj;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length > 0) {
          if ("text" in parsed || "source" in parsed || "findings" in parsed || "summary" in parsed || "answer" in parsed || "message" in parsed || "reply" in parsed || "response" in parsed) {
            return parsed;
          }
          if (!fallbackObj) fallbackObj = parsed;
        }
      }
    } catch {
    }
  }
  return fallbackObj;
}
function parseProviderContent(content, reasoning) {
  let parsed = null;
  let parseError = null;
  if (typeof content === "string" && content.trim() !== "") {
    let clean = content.trim();
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/g, "");
    clean = clean.replace(/^[\s\S]*?(?=\{)/, "").trim();
    const lastBrace = clean.lastIndexOf("}");
    if (lastBrace !== -1) clean = clean.slice(0, lastBrace + 1);
    try {
      parsed = JSON.parse(clean);
    } catch (firstError) {
      parseError = firstError;
      const firstBrace = content.indexOf("{");
      const last = content.lastIndexOf("}");
      if (firstBrace !== -1 && last !== -1 && last > firstBrace) {
        const extracted = content.slice(firstBrace, last + 1);
        try {
          parsed = JSON.parse(extracted);
          parseError = null;
        } catch {
        }
        if (!parsed) {
          try {
            const unwrapped = JSON.parse(`"${extracted.replace(/"/g, '\\"')}"`);
            if (typeof unwrapped === "string") {
              parsed = JSON.parse(unwrapped);
              parseError = null;
            }
          } catch {
          }
        }
      }
    }
  } else {
    parseError = new Error("empty model response");
  }
  const isEmptyObj = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  if ((!parsed || isEmptyObj) && typeof reasoning === "string") {
    const fromReasoning = extractJsonFromText(reasoning);
    if (fromReasoning) {
      return fromReasoning;
    }
  }
  if (parseError && !parsed) {
    throw parseError;
  }
  return parsed;
}
function providerError(error, request) {
  const message = error instanceof Error ? error.message : "model request failed";
  const code = /timeout|aborted/i.test(message) ? "model_timeout" : /empty/i.test(message) ? "empty_model_response" : /unavailable|fetch|network|ECONN/i.test(message) ? "model_unavailable" : "model_rejected_request";
  return { kind: "ai-error", code, message: message.slice(0, 500), retryable: code === "model_timeout" || code === "model_unavailable", requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId };
}
function normalizeResponse(value, request) {
  if (typeof value === "string" && request.responseFormat === "chat-result") {
    const text = value.replace(/^>\s*\/\/\s*/, "").replace(/\s*\/\/\s*$/, "").trim();
    if (text) {
      return { requestId: request.requestId, runId: request.runId, modelId: request.modelId, taskType: request.taskType, completedAt: (/* @__PURE__ */ new Date()).toISOString(), result: { text } };
    }
  }
  if (!value || typeof value !== "object") throw new Error("invalid model response");
  const raw = value;
  let result = raw.result ?? value;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result;
    for (const key of ["artifactKind", "artifactFilename", "artifactRationale", "outputMode"]) {
      if (typeof obj[key] === "string" && obj[key].trim() === "") {
        delete obj[key];
      }
    }
  }
  if (request.responseFormat === "chat-result" && result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result;
    if (obj.text !== void 0 && obj.text !== null) {
      result = { text: String(obj.text).trim() };
    } else {
      const altKeys = ["message", "response", "answer", "reply", "content", "output", "result", "summary", "displayed_text"];
      let found;
      for (const k of altKeys) {
        if (obj[k] !== void 0 && obj[k] !== null) {
          found = typeof obj[k] === "object" ? JSON.stringify(obj[k]) : String(obj[k]).trim();
          break;
        }
      }
      if (!found) {
        const keys = Object.keys(obj);
        if (keys.length === 1 && obj[keys[0]] !== void 0 && obj[keys[0]] !== null) {
          found = typeof obj[keys[0]] === "object" ? JSON.stringify(obj[keys[0]]) : String(obj[keys[0]]).trim();
        }
      }
      if (found) {
        result = { text: found };
      }
    }
  }
  return { requestId: request.requestId, runId: request.runId, modelId: request.modelId, taskType: request.taskType, completedAt: (/* @__PURE__ */ new Date()).toISOString(), result };
}

// backend/src/main/run/filesystem.ts
var import_node_fs3 = require("node:fs");
var import_node_path4 = __toESM(require("node:path"), 1);

// backend/src/main/persistence/paths.ts
var import_node_path3 = __toESM(require("node:path"), 1);
var ABS_WIN = /^[a-zA-Z]:[\\/]|^\\\\/;
var ABS_POSIX = /^\//;
function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("relative_path must be a non-empty string");
  }
  if (ABS_WIN.test(relativePath) || ABS_POSIX.test(relativePath) || import_node_path3.default.isAbsolute(relativePath)) {
    throw new Error(`absolute path rejected: ${relativePath}`);
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`path traversal rejected: ${relativePath}`);
  }
  if (relativePath.includes("\0")) {
    throw new Error("null byte rejected in relative_path");
  }
}

// backend/src/main/run/filesystem.ts
var MAX_ATTACHMENT = 25 * 1024 * 1024;
var configuredDataDir2 = null;
function setDataDir(dir) {
  configuredDataDir2 = dir;
}
function dataRoot() {
  if (configuredDataDir2) return configuredDataDir2;
  if (process.env.WORKBENCH_DATA_ROOT) return process.env.WORKBENCH_DATA_ROOT;
  return import_node_path4.default.join(process.cwd(), "data");
}
function absoluteDataPath(relativePath) {
  assertSafeRelativePath(relativePath);
  const root = import_node_path4.default.resolve(dataRoot());
  const target = import_node_path4.default.resolve(root, relativePath);
  if (!target.startsWith(`${root}${import_node_path4.default.sep}`)) throw new Error("data path escapes root");
  return target;
}
function runRoot(runId) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("invalid run id");
  return import_node_path4.default.join(dataRoot(), "runs", runId);
}
function createRunDirectories(runId) {
  const root = runRoot(runId);
  for (const name of ["input", "intermediate", "output", "logs"]) (0, import_node_fs3.mkdirSync)(import_node_path4.default.join(root, name), { recursive: true });
  return root;
}
function resolveRunPath(runId, relativePath, area) {
  assertSafeRelativePath(relativePath);
  const root = runRoot(runId);
  const target = import_node_path4.default.resolve(root, relativePath);
  if (!target.startsWith(`${root}${import_node_path4.default.sep}`)) throw new Error("path escapes run");
  if (area) {
    const areaRoot = import_node_path4.default.join(root, area);
    if (target !== areaRoot && !target.startsWith(`${areaRoot}${import_node_path4.default.sep}`)) throw new Error("path outside permitted run area");
  }
  return target;
}
function writeRunFile(runId, area, filename, content, overwrite = false) {
  assertSafeRelativePath(filename);
  const target = resolveRunPath(runId, `${area}/${filename}`, area);
  (0, import_node_fs3.mkdirSync)(import_node_path4.default.dirname(target), { recursive: true });
  (0, import_node_fs3.writeFileSync)(target, content, { flag: overwrite ? "w" : "wx" });
  return `runs/${runId}/${area}/${filename}`;
}

// backend/src/main/run/images.ts
var MAX_EDGE_PX = 1024;
var JPEG_QUALITY = 80;
var PASSTHROUGH_BYTES = 900 * 1024;
var MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
var PDF_DPI = 150;
var MAX_PDF_PAGES = 10;
async function importOptional(specifier) {
  try {
    return await import(
      /* @vite-ignore */
      specifier
    );
  } catch {
    return void 0;
  }
}
async function loadNativeImage() {
  try {
    const electron = await importOptional("electron");
    return electron?.nativeImage ?? electron?.default?.nativeImage;
  } catch {
    return void 0;
  }
}
async function loadPdfJs() {
  const legacy = await importOptional("pdfjs-dist/legacy/build/pdf.mjs");
  if (legacy) return legacy;
  return await importOptional("pdfjs-dist");
}
async function loadCanvas() {
  const canvasMod = await importOptional("canvas");
  return canvasMod?.createCanvas ? canvasMod : canvasMod?.default;
}
async function prepareImage(input, mediaType) {
  const passthrough = () => ({
    buffer: input,
    mediaType,
    resized: false,
    originalBytes: input.length,
    finalBytes: input.length
  });
  if (!mediaType.startsWith("image/") || mediaType === "image/svg+xml" || mediaType === "image/gif")
    return passthrough();
  const factory = await loadNativeImage();
  if (!factory) return passthrough();
  try {
    const image = factory.createFromBuffer(input);
    if (image.isEmpty()) return passthrough();
    const { width, height } = image.getSize();
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height, 1));
    const fitted = scale < 1 ? image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: "better"
    }) : image;
    const jpeg = fitted.toJPEG(JPEG_QUALITY);
    if (!jpeg.length || jpeg.length >= input.length) return passthrough();
    return { buffer: jpeg, mediaType: "image/jpeg", resized: true, originalBytes: input.length, finalBytes: jpeg.length };
  } catch {
    return passthrough();
  }
}
function assertUploadableSize(finalBytes) {
  if (finalBytes > MAX_UPLOAD_BYTES)
    throw new Error(
      `image too large to send (${(finalBytes / 1048576).toFixed(1)}MB after processing, limit 5MB); attach a smaller file`
    );
}
function estimateVisionTokens(width, height) {
  const tilesX = Math.ceil(width / 448);
  const tilesY = Math.ceil(height / 448);
  return tilesX * tilesY * 256;
}
async function renderPdfToImages(pdfBuffer, pageNumbers) {
  const text = pdfBuffer.toString("latin1");
  const pageMatches = text.match(/\/Type\s*\/Page[^s]/g);
  const pageCount = Math.min(pageMatches ? pageMatches.length : 1, MAX_PDF_PAGES);
  try {
    const pdfjs = await loadPdfJs();
    if (pdfjs?.getDocument) {
      const canvasMod = await loadCanvas();
      const createCanvas = canvasMod?.createCanvas;
      if (createCanvas) {
        const renderCanvas = createCanvas;
        class LocalCanvasFactory {
          create(width, height) {
            const canvas = renderCanvas(width, height);
            return { canvas, context: canvas.getContext("2d") };
          }
          reset(target, width, height) {
            target.canvas.width = width;
            target.canvas.height = height;
          }
          destroy(target) {
            target.canvas.width = 0;
            target.canvas.height = 0;
            target.canvas = null;
            target.context = null;
          }
        }
        const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), CanvasFactory: LocalCanvasFactory }).promise;
        const targetPages = pageNumbers && pageNumbers.length > 0 ? pageNumbers.filter((p) => p >= 1 && p <= doc.numPages) : Array.from({ length: Math.min(doc.numPages, MAX_PDF_PAGES) }, (_, i) => i + 1);
        const images = [];
        for (const i of targetPages) {
          const page = await doc.getPage(i);
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(PDF_DPI / 72, MAX_EDGE_PX / Math.max(baseViewport.width, baseViewport.height));
          const viewport = page.getViewport({ scale });
          const canvas = createCanvas(viewport.width, viewport.height);
          const ctx = canvas.getContext("2d");
          await page.render({ canvasContext: ctx, viewport }).promise;
          const raw = canvas.toBuffer("image/jpeg", { quality: JPEG_QUALITY / 100 });
          const prepared = await prepareImage(raw, "image/jpeg");
          images.push(prepared);
        }
        if (images.length) return images;
      }
    }
  } catch (error) {
    console.warn("PDF source rendering failed:", error instanceof Error ? error.message : String(error));
  }
  return [];
}
async function renderSvgToImage(raw) {
  const canvasModule = await loadCanvas();
  if (!canvasModule?.createCanvas || !canvasModule.loadImage) throw new Error("SVG visual extraction requires a local image renderer.");
  const image = await canvasModule.loadImage(raw);
  const scale = Math.min(1, MAX_EDGE_PX / Math.max(image.width, image.height, 1));
  const canvas = canvasModule.createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const buffer = canvas.toBuffer("image/jpeg", { quality: JPEG_QUALITY / 100 });
  return { buffer, mediaType: "image/jpeg", resized: true, originalBytes: raw.length, finalBytes: buffer.length };
}
var SVG_TEXT_CACHE_MAX_SIZE = 50;
var svgTextCache = /* @__PURE__ */ new Map();
function computeFnv1a32(buffer) {
  let hash = 2166136261;
  for (let i = 0; i < buffer.length; i++) {
    hash ^= buffer[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function extractSvgText(svgBuffer, maxChars = 8e3) {
  const key = computeFnv1a32(svgBuffer);
  const cached = svgTextCache.get(key);
  if (cached !== void 0) {
    svgTextCache.delete(key);
    svgTextCache.set(key, cached);
    return maxChars === null ? cached : cached.slice(0, maxChars);
  }
  const result = computeExtractSvgText(svgBuffer);
  if (svgTextCache.size >= SVG_TEXT_CACHE_MAX_SIZE) {
    const firstKey = svgTextCache.keys().next().value;
    if (firstKey !== void 0) svgTextCache.delete(firstKey);
  }
  svgTextCache.set(key, result);
  return maxChars === null ? result : result.slice(0, maxChars);
}
function computeExtractSvgText(svgBuffer) {
  const raw = svgBuffer.toString("utf-8");
  const lines = [];
  const decodeXml = (s) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&deg;/g, "\xB0").replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec))).replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\s+/g, " ").trim();
  const textTagMatches = raw.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi);
  for (const match of textTagMatches) {
    const cleanText = decodeXml(match[1]);
    if (cleanText && !lines.includes(cleanText)) {
      lines.push(cleanText);
    }
  }
  const metadataMatches = raw.matchAll(/<(?:title|desc)\b[^>]*>([\s\S]*?)<\/(?:title|desc)>/gi);
  for (const match of metadataMatches) {
    const cleanText = decodeXml(match[1]);
    if (cleanText && !lines.includes(cleanText)) {
      lines.push(cleanText);
    }
  }
  return lines.join("\n");
}

// backend/src/main/logger.ts
var isColorSupported = !process.env.NO_COLOR && (Boolean(process.stdout?.isTTY) || process.env.FORCE_COLOR === "1" || process.env.TERM !== "dumb");
var c = {
  reset: isColorSupported ? "\x1B[0m" : "",
  bold: isColorSupported ? "\x1B[1m" : "",
  dim: isColorSupported ? "\x1B[2m" : "",
  cyan: isColorSupported ? "\x1B[36m" : "",
  green: isColorSupported ? "\x1B[32m" : "",
  yellow: isColorSupported ? "\x1B[33m" : "",
  red: isColorSupported ? "\x1B[31m" : "",
  blue: isColorSupported ? "\x1B[34m" : "",
  magenta: isColorSupported ? "\x1B[35m" : "",
  gray: isColorSupported ? "\x1B[90m" : ""
};
function logModelRequest(req) {
  const shortId = req.requestId.slice(0, 8);
  const promptSnippet = req.userPromptPreview ? req.userPromptPreview.replace(/[\r\n\t]+/g, " ").trim().slice(0, 100) : "";
  console.log(
    `
${c.blue}\u250C\u2500 [AI Request: ${req.taskType.toUpperCase()}]${c.reset} ${c.dim}(req:${shortId})${c.reset}
${c.blue}\u2502${c.reset} Model:   ${c.bold}${req.providerModel}${c.reset} (${req.modelId})
${c.blue}\u2502${c.reset} Params:  max_tokens=${req.maxTokens} \u2502 temp=${req.temperature}
` + (promptSnippet ? `${c.blue}\u2502${c.reset} Prompt:  ${c.dim}"${promptSnippet}${promptSnippet.length >= 100 ? "..." : ""}"${c.reset}
` : "") + `${c.blue}\u2514\u2500${"\u2500".repeat(54)}${c.reset}`
  );
}
function logModelResponse(res) {
  const shortId = res.requestId.slice(0, 8);
  const ok = res.status >= 200 && res.status < 300;
  const statusStr = ok ? `${c.green}HTTP ${res.status}${c.reset}` : `${c.red}HTTP ${res.status}${c.reset}`;
  console.log(
    `${c.cyan}\u250C\u2500 [AI Response: ${res.taskType.toUpperCase()}]${c.reset} ${c.dim}(req:${shortId})${c.reset}
${c.cyan}\u2502${c.reset} Status:  ${statusStr} in ${c.bold}${res.latencyMs}ms${c.reset} (finish: ${res.finishReason ?? "stop"}${res.chars ? `, ${res.chars} chars` : ""})
${c.cyan}\u2514\u2500${"\u2500".repeat(54)}${c.reset}`
  );
}
function logGeneratedCode(code) {
  const lines = code.source.trim().split("\n");
  const header = `${c.cyan}\u250C\u2500\u2500 ${c.bold}[Generated Script: ${code.filename}]${c.reset} ${c.cyan}${"\u2500".repeat(Math.max(4, 52 - code.filename.length))}${c.reset}`;
  const formattedLines = lines.map((line, idx) => {
    const num = String(idx + 1).padStart(3, " ");
    return `${c.cyan}\u2502${c.reset} ${c.gray}${num} \u2502${c.reset} ${line}`;
  });
  const parts = [header, ...formattedLines];
  parts.push(`${c.cyan}\u251C\u2500\u2500 Details ${"\u2500".repeat(46)}${c.reset}`);
  parts.push(`${c.cyan}\u2502${c.reset}   Output Mode: ${c.bold}${code.outputMode ?? "chat"}${c.reset}`);
  if (code.artifactKind) {
    parts.push(`${c.cyan}\u2502${c.reset}   Artifact:    ${c.green}${code.artifactKind}${c.reset}${code.artifactFilename ? ` -> ${code.artifactFilename}` : ""}`);
  }
  if (code.expectedResult) {
    parts.push(`${c.cyan}\u2502${c.reset}   Expected:    ${c.dim}${code.expectedResult.slice(0, 100)}${c.reset}`);
  }
  parts.push(`${c.cyan}\u2514\u2500\u2500${"\u2500".repeat(56)}${c.reset}`);
  console.log(parts.join("\n"));
}
function logModelSummary(summary, verified) {
  const lines = summary.trim().split("\n");
  const parts = [
    `${c.cyan}\u250C\u2500\u2500 [Model Summary] ${verified !== void 0 ? verified ? `${c.green}(verified)` : `${c.yellow}(unverified)` : ""}${"\u2500".repeat(36)}${c.reset}`
  ];
  for (const l of lines.slice(0, 12)) {
    parts.push(`${c.cyan}\u2502${c.reset} ${l}`);
  }
  if (lines.length > 12) {
    parts.push(`${c.cyan}\u2502${c.reset} ${c.dim}... (${lines.length - 12} more lines)${c.reset}`);
  }
  parts.push(`${c.cyan}\u2514\u2500\u2500${"\u2500".repeat(56)}${c.reset}`);
  console.log(parts.join("\n"));
}
function logVisionFindings(findings) {
  const parts = [
    `${c.cyan}\u250C\u2500\u2500 [Vision Findings: ${findings.length} item(s)] ${"\u2500".repeat(34)}${c.reset}`
  ];
  for (let i = 0; i < findings.length && i < 8; i++) {
    const f = findings[i];
    const val = f.value ? `: ${f.value}` : "";
    const conf = f.confidence ? ` ${c.dim}(${f.confidence})${c.reset}` : "";
    parts.push(`${c.cyan}\u2502${c.reset} \u2022 ${c.bold}${f.title}${c.reset}${val}${conf}`);
  }
  if (findings.length > 8) {
    parts.push(`${c.cyan}\u2502${c.reset} ${c.dim}... (${findings.length - 8} more findings)${c.reset}`);
  }
  parts.push(`${c.cyan}\u2514\u2500\u2500${"\u2500".repeat(56)}${c.reset}`);
  console.log(parts.join("\n"));
}
function logGatewayError(request, message, detail) {
  const shortId = request.requestId.slice(0, 8);
  console.error(
    `${c.red}\u250C\u2500\u2500 [AI Gateway Error: ${request.taskType.toUpperCase()}] (req:${shortId}) ${"\u2500".repeat(24)}${c.reset}
${c.red}\u2502${c.reset} Message: ${message}
` + (detail ? `${c.red}\u2502${c.reset} Detail:  ${c.dim}${detail.slice(0, 200)}${c.reset}
` : "") + `${c.red}\u2514\u2500\u2500${"\u2500".repeat(56)}${c.reset}`
  );
}

// backend/src/main/agent/context-manager.ts
var import_gpt_tokenizer = require("gpt-tokenizer");
function countTokens(text) {
  if (!text) return 0;
  try {
    return (0, import_gpt_tokenizer.encode)(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

// backend/src/main/gateway/telemetry.ts
var import_node_fs4 = require("node:fs");
var import_node_path5 = __toESM(require("node:path"), 1);
var MODES = ["default", "template_off"];
function resolveReasoningControl(env = process.env) {
  const raw = (env.WORKBENCH_REASONING_MODE ?? "default").trim().toLowerCase();
  const mode = MODES.includes(raw) ? raw : "default";
  switch (mode) {
    case "template_off":
      return { mode, params: { chat_template_kwargs: { enable_thinking: false } } };
    default:
      return { mode: "default", params: {} };
  }
}
function parseProviderUsage(usage) {
  if (!usage || typeof usage !== "object") return { source: "unavailable" };
  const u = usage;
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  const reasoningTokens = num(u.completion_tokens_details?.reasoning_tokens);
  if (promptTokens === void 0 && completionTokens === void 0 && reasoningTokens === void 0) return { source: "unavailable" };
  const source = promptTokens !== void 0 && completionTokens !== void 0 ? "provider" : "partial";
  return { source, promptTokens, completionTokens, reasoningTokens };
}
var runStarts = /* @__PURE__ */ new Map();
function markRunStart(runId) {
  if (!runStarts.has(runId)) runStarts.set(runId, Date.now());
}
function telemetryPath(runId) {
  createRunDirectories(runId);
  const logsDir = import_node_path5.default.join(runRoot(runId), "logs");
  (0, import_node_fs4.mkdirSync)(logsDir, { recursive: true });
  return import_node_path5.default.join(logsDir, "inference-telemetry.jsonl");
}
function recordInference(record) {
  try {
    markRunStart(record.runId);
    (0, import_node_fs4.appendFileSync)(telemetryPath(record.runId), `${JSON.stringify(record)}
`);
  } catch (e) {
    console.warn("[telemetry] failed to persist inference record:", e instanceof Error ? e.message : String(e));
  }
}

// backend/src/main/gateway/model-gateway.ts
function gatewayConsole(level, request, message, extra) {
  const prefix = `[model-gateway:${request.taskType}:${request.modelId}:${request.requestId.slice(0, 8)}]`;
  const line = extra !== void 0 ? `${prefix} ${message} ${typeof extra === "string" ? extra : JSON.stringify(extra).slice(0, 4e3)}` : `${prefix} ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
function persistGatewayTrace(runId, requestId, entry2) {
  try {
    createRunDirectories(runId);
    const root = runRoot(runId);
    const logsDir = import_node_path6.default.join(root, "logs");
    (0, import_node_fs5.mkdirSync)(logsDir, { recursive: true });
    const safeEntry = redactTraceContent(entry2);
    const payload = { timestamp: (/* @__PURE__ */ new Date()).toISOString(), requestId, runId, ...safeEntry };
    const perRequestPath = import_node_path6.default.join(logsDir, `model-${entry2["taskType"] ?? "unknown"}-${requestId}.json`);
    try {
      (0, import_node_fs5.writeFileSync)(perRequestPath, JSON.stringify(payload, null, 2), { flag: "w" });
    } catch {
      (0, import_node_fs5.writeFileSync)(perRequestPath, JSON.stringify(payload, null, 2));
    }
    const auditPath = import_node_path6.default.join(logsDir, "model-gateway.log");
    (0, import_node_fs5.appendFileSync)(auditPath, `${JSON.stringify(payload)}
`);
  } catch (e) {
    console.warn(`[model-gateway] failed to persist trace for ${requestId}:`, e instanceof Error ? e.message : String(e));
  }
}
function redactTraceContent(value, key = "") {
  const sensitive = /^(?:bodyPreview|rawText|content|reasoning|extractedContent|parsedJson|result|envelope|systemPromptPreview|userPromptPreview|messages|toolCalls)$/i;
  if (sensitive.test(key)) {
    const chars = typeof value === "string" ? value.length : value == null ? 0 : JSON.stringify(value).length;
    return `[omitted; ${chars} chars]`;
  }
  if (Array.isArray(value)) return value.map((item) => redactTraceContent(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactTraceContent(v, k)]));
  }
  return value;
}
var nativeTransport = {
  async request(url, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const body = await response.text();
      return { status: response.status, text: async () => body };
    } finally {
      clearTimeout(timer);
    }
  },
  async streamRequest(url, init, timeoutMs, onChunk) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status < 200 || response.status >= 300 || !response.body) {
        return response;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulatedText = "";
      let accumulatedReasoning = "";
      const accumulatedToolCalls = [];
      let finishReason = null;
      let usage = void 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith(":")) continue;
            if (trimmed === "data: [DONE]") continue;
            if (trimmed.startsWith("data: ")) {
              const jsonStr = trimmed.slice(6);
              try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.usage) {
                  usage = parsed.usage;
                }
                const choice = parsed.choices?.[0];
                if (choice) {
                  if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                  }
                  const delta = choice.delta;
                  if (delta) {
                    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
                      accumulatedReasoning += delta.reasoning_content;
                    }
                    if (typeof delta.content === "string" && delta.content.length > 0) {
                      accumulatedText += delta.content;
                      onChunk(delta.content);
                    }
                    if (Array.isArray(delta.tool_calls)) {
                      for (const tc of delta.tool_calls) {
                        if (!tc || typeof tc !== "object") continue;
                        const idx = typeof tc.index === "number" ? tc.index : accumulatedToolCalls.length;
                        if (!accumulatedToolCalls[idx]) {
                          accumulatedToolCalls[idx] = {
                            id: tc.id ?? `call_${idx}`,
                            type: tc.type ?? "function",
                            function: {
                              name: tc.function?.name ?? "",
                              arguments: tc.function?.arguments ?? ""
                            }
                          };
                        } else {
                          if (tc.id) accumulatedToolCalls[idx].id = tc.id;
                          if (tc.type) accumulatedToolCalls[idx].type = tc.type;
                          if (tc.function?.name) {
                            accumulatedToolCalls[idx].function.name += tc.function.name;
                          }
                          if (tc.function?.arguments) {
                            accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                          }
                        }
                      }
                    }
                  }
                }
              } catch {
              }
            }
          }
        }
      } catch (streamErr) {
        if (streamErr.name === "AbortError") throw streamErr;
      }
      const messageObj = {
        role: "assistant",
        content: accumulatedText.length > 0 ? accumulatedText : accumulatedReasoning.length > 0 && accumulatedToolCalls.length === 0 ? accumulatedReasoning : accumulatedToolCalls.length > 0 ? null : ""
      };
      if (accumulatedReasoning.length > 0) {
        messageObj.reasoning_content = accumulatedReasoning;
      }
      if (accumulatedToolCalls.length > 0) {
        messageObj.tool_calls = accumulatedToolCalls.filter(Boolean);
      }
      const syntheticEnvelope = JSON.stringify({
        choices: [
          {
            message: messageObj,
            finish_reason: finishReason ?? (accumulatedToolCalls.length > 0 ? "tool_calls" : "stop")
          }
        ],
        usage
      });
      return {
        status: response.status,
        async text() {
          return syntheticEnvelope;
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }
};
function formatMessagesForNativeTools(messages) {
  return messages.map((m) => {
    if (m.role === "assistant") {
      const formatted = {
        role: "assistant",
        content: typeof m.content === "string" && m.content.trim().length > 0 ? m.content : null
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        formatted.tool_calls = m.tool_calls.map((tc) => {
          if (tc.type === "function" && tc.function && typeof tc.function.name === "string") {
            return {
              id: String(tc.id ?? (0, import_node_crypto.randomUUID)()),
              type: "function",
              function: {
                name: tc.function.name,
                arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {})
              }
            };
          }
          return {
            id: String(tc.id ?? (0, import_node_crypto.randomUUID)()),
            type: "function",
            function: {
              name: String(tc.name ?? tc.function?.name ?? "unknown"),
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? tc.function?.arguments ?? {})
            }
          };
        });
      }
      return formatted;
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: String(m.tool_call_id ?? ""),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
      };
    }
    return {
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content ?? "")
    };
  });
}
function formatMessagesForFallback(messages, systemPromptAddition) {
  return messages.map((m, idx) => {
    if (idx === 0 && m.role === "system") {
      return {
        role: "system",
        content: `${m.content ?? ""}${systemPromptAddition}`
      };
    }
    if (m.role === "assistant") {
      let content = typeof m.content === "string" ? m.content : "";
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const calls2 = m.tool_calls.map((tc) => ({
          name: tc.name ?? tc.function?.name,
          arguments: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments ?? tc.function?.arguments ?? {}
        }));
        content = content ? `${content}
${JSON.stringify({ tool_calls: calls2 })}` : JSON.stringify({ content: null, tool_calls: calls2 });
      }
      return {
        role: "assistant",
        content
      };
    }
    if (m.role === "tool") {
      const toolIdentifier = m.toolName || m.tool_call_id || "tool";
      return {
        role: "user",
        content: `[Observed result from ${toolIdentifier}]:
${typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")}`
      };
    }
    return {
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content ?? "")
    };
  });
}
function normalizeParsedToolArgs(val) {
  return val;
}
function parseToolCallArguments(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return normalizeParsedToolArgs(raw);
  }
  if (typeof raw !== "string") return {};
  const str = raw.trim();
  if (!str) return {};
  try {
    const parsed = parseStructuredData(str);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return normalizeParsedToolArgs(parsed);
    }
    if (typeof parsed === "string" && parsed.trim().startsWith("{")) {
      const doubleParsed = parseStructuredData(parsed.trim());
      if (typeof doubleParsed === "object" && doubleParsed !== null && !Array.isArray(doubleParsed)) {
        return normalizeParsedToolArgs(doubleParsed);
      }
    }
  } catch {
  }
  try {
    const repaired = str.replace(/"((?:\\.|[^"\\])*)"/gs, (match) => {
      return match.replace(/\r\n|\n|\r/g, "\\n").replace(/\t/g, "\\t");
    });
    const parsed = JSON.parse(repaired);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return normalizeParsedToolArgs(parsed);
    }
  } catch {
  }
  return { raw: str };
}
function extractEmbeddedToolCalls(rawContent) {
  const toolCalls = [];
  let cleaned = rawContent;
  const xmlPattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = xmlPattern.exec(rawContent)) !== null) {
    const jsonCandidate = match[1].trim();
    try {
      const parsed = parseStructuredData(jsonCandidate);
      if (parsed && typeof parsed.name === "string") {
        const args = parseToolCallArguments(parsed.arguments ?? parsed.parameters ?? {});
        toolCalls.push({
          id: parsed.id || `call_${(0, import_node_crypto.randomUUID)().slice(0, 8)}`,
          name: parsed.name,
          arguments: args
        });
      }
    } catch {
      const args = parseToolCallArguments(jsonCandidate);
      const nameMatch = jsonCandidate.match(/["']?name["']?\s*:\s*["']([^"'\r\n]+)["']/i);
      if (nameMatch && nameMatch[1]) {
        toolCalls.push({
          id: `call_${(0, import_node_crypto.randomUUID)().slice(0, 8)}`,
          name: nameMatch[1].trim(),
          arguments: args
        });
      }
    }
  }
  if (toolCalls.length > 0) {
    cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim();
    return { toolCalls, cleanedContent: cleaned.length > 0 ? cleaned : null };
  }
  const trimmed = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = parseStructuredData(trimmed);
      if (parsed && typeof parsed.name === "string" && (parsed.arguments || parsed.parameters)) {
        const args = parseToolCallArguments(parsed.arguments ?? parsed.parameters ?? {});
        toolCalls.push({
          id: parsed.id || `call_${(0, import_node_crypto.randomUUID)().slice(0, 8)}`,
          name: parsed.name,
          arguments: args
        });
        return { toolCalls, cleanedContent: null };
      } else if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if (tc && typeof tc.name === "string") {
            const args = parseToolCallArguments(tc.arguments ?? tc.parameters ?? tc.function?.arguments ?? {});
            toolCalls.push({
              id: tc.id || `call_${(0, import_node_crypto.randomUUID)().slice(0, 8)}`,
              name: tc.name,
              arguments: args
            });
          }
        }
        if (toolCalls.length > 0) {
          const c2 = parsed.content ? String(parsed.content).trim() : null;
          return { toolCalls, cleanedContent: c2 && c2.length > 0 ? c2 : null };
        }
      }
    } catch {
    }
  }
  return { toolCalls: [], cleanedContent: rawContent };
}
function getJsonSchema(responseFormat) {
  if (responseFormat === "code-result") {
    return {
      type: "json_schema",
      json_schema: {
        name: "code_result",
        strict: false,
        schema: {
          type: "object",
          properties: {
            filename: { type: "string" },
            source: { type: "string" },
            expectedResult: { type: "string" },
            inputFiles: { type: "array", items: { type: "string" } },
            outputFiles: { type: "array", items: { type: "string" } },
            allowedImports: { type: "array", items: { type: "string", enum: ["csv", "datetime", "math"] } },
            outputMode: { type: "string", enum: ["chat", "artifact", "chat_and_artifact"] },
            artifactKind: { type: "string", enum: ["docx", "pdf", "xlsx", "csv", "txt", "json", "md", ""] },
            artifactFilename: { type: "string" },
            artifactRationale: { type: "string" }
          },
          required: ["filename", "source", "expectedResult", "inputFiles", "outputFiles", "allowedImports"]
        }
      }
    };
  }
  if (responseFormat === "vision-result") {
    return {
      type: "json_schema",
      json_schema: {
        name: "vision_result",
        strict: false,
        schema: {
          type: "object",
          properties: {
            sourceText: { type: "string" },
            findings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  findingId: { type: "string" },
                  title: { type: "string" },
                  value: { type: "string" },
                  pageReferenceIds: { type: "array", items: { type: "string" } },
                  confidence: { type: "string", enum: ["high", "medium", "low"] },
                  evidence: { type: "string" }
                },
                required: ["findingId", "title", "value", "pageReferenceIds", "confidence", "evidence"]
              }
            },
            pageReferences: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  page: { type: "integer" },
                  text: { type: "string" },
                  location: { type: "string" }
                },
                required: ["id", "page", "text"]
              }
            }
          },
          required: ["findings", "pageReferences"]
        }
      }
    };
  }
  if (responseFormat === "draft-result") {
    return {
      type: "json_schema",
      json_schema: {
        name: "draft_result",
        strict: false,
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            sections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", enum: ["equipment-header", "findings-summary", "recommendation"] },
                  heading: { type: "string" },
                  body: { type: "string" }
                },
                required: ["id", "heading", "body"]
              }
            },
            missingInformation: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  note: { type: "string" }
                },
                required: ["field", "note"]
              }
            }
          },
          required: ["title", "body", "sections", "missingInformation"]
        }
      }
    };
  }
  if (responseFormat === "harness-step") {
    return {
      type: "json_schema",
      json_schema: {
        name: "harness_step",
        strict: false,
        schema: {
          type: "object",
          properties: {
            thought: { type: "string" },
            action: { type: "string", enum: ["tool_call", "final_answer"] },
            tool: { type: "string", enum: ["list_dir", "read_file", "search", "write_file", "run_command"] },
            args: { type: "object" },
            text: { type: "string" }
          },
          required: ["thought", "action"]
        }
      }
    };
  }
  if (responseFormat === "file-result") {
    return {
      type: "json_schema",
      json_schema: {
        name: "file_result",
        strict: false,
        schema: {
          type: "object",
          properties: {
            filename: { type: "string" },
            content: { type: "string" }
          },
          required: ["filename", "content"]
        }
      }
    };
  }
  return void 0;
}
var ModelGateway = class {
  constructor(transport = nativeTransport, initialRegistry) {
    this.transport = transport;
    this.dbRegistry = /* @__PURE__ */ new Map();
    if (initialRegistry) {
      this.updateRegistry(initialRegistry);
    } else {
      const entries = loadProductionRegistryEntriesFromDb();
      this.updateRegistry(entries);
    }
  }
  dbRegistry;
  endpointPool = /* @__PURE__ */ new Map();
  roundRobinCounter = 0;
  externalRequestCount = 0;
  lastVisionUpload;
  delegatedInvocationListeners = [];
  onDelegatedInvocation(listener) {
    this.delegatedInvocationListeners.push(listener);
    return () => {
      this.delegatedInvocationListeners = this.delegatedInvocationListeners.filter((l) => l !== listener);
    };
  }
  /**
   * Register multiple instances / endpoints for a given model ID (worker pool).
   */
  registerModelInstances(modelId, instances) {
    if (!instances || instances.length === 0) return;
    this.endpointPool.set(modelId, instances);
    this.dbRegistry.set(modelId, instances[0]);
  }
  /**
   * Get all registered worker instances for a given model ID.
   */
  getModelInstances(modelId) {
    return this.endpointPool.get(modelId) ?? (this.registry.has(modelId) ? [this.registry.get(modelId)] : []);
  }
  /**
   * Select next healthy endpoint for the requested model using round-robin load balancing.
   */
  resolveNextEndpoint(modelId) {
    const instances = this.endpointPool.get(modelId);
    if (instances && instances.length > 0) {
      const enabledInstances = instances.filter((inst) => inst.enabled);
      if (enabledInstances.length > 0) {
        const selected = enabledInstances[this.roundRobinCounter % enabledInstances.length];
        this.roundRobinCounter++;
        return selected;
      }
    }
    const dbModel = this.dbRegistry.get(modelId);
    if (dbModel && dbModel.enabled) {
      return dbModel;
    }
    const allEnabled = Array.from(this.dbRegistry.values()).filter((e) => e.enabled && !e.fallbackOnly);
    if (allEnabled.length > 0) {
      const distinctEndpoints = new Set(allEnabled.map((e) => `${e.baseUrl}/${e.model}`));
      if (distinctEndpoints.size === 1) {
        return allEnabled[0];
      }
    }
    return void 0;
  }
  rebuildEndpointPool() {
    this.endpointPool.clear();
    for (const [id, entry2] of this.dbRegistry.entries()) {
      if (!this.endpointPool.has(id)) {
        this.endpointPool.set(id, [entry2]);
      }
    }
  }
  get registry() {
    return this.dbRegistry;
  }
  /** Dynamically replace production DB registry entries in memory without requiring application restart. */
  updateRegistry(entries) {
    this.dbRegistry.clear();
    this.endpointPool.clear();
    if (Array.isArray(entries)) {
      for (const entry2 of entries) {
        if (!this.dbRegistry.has(entry2.id)) {
          this.dbRegistry.set(entry2.id, entry2);
        }
        const list = this.endpointPool.get(entry2.id) ?? [];
        list.push(entry2);
        this.endpointPool.set(entry2.id, list);
      }
    } else {
      for (const [k, v] of entries) {
        this.dbRegistry.set(k, v);
        this.endpointPool.set(k, [v]);
      }
    }
  }
  updateDbRegistry(entries) {
    this.updateRegistry(entries);
  }
  /** `ModelClient` surface: delegates to `execute`. */
  async complete(request) {
    return this.execute(request);
  }
  async execute(request) {
    let model = this.resolveNextEndpoint(request.modelId);
    if (!model) {
      try {
        model = resolveModel(this.dbRegistry, request.modelId, request.taskType);
      } catch {
        return { ok: false, error: { kind: "ai-error", code: "model_unavailable", message: "configured model is unavailable", retryable: false, requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId } };
      }
    }
    gatewayConsole("log", request, `DB ENDPOINT: Dispatching to ${model.baseUrl} (${model.model}, role: ${request.taskType})`);
    const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : void 0;
    const maybeVision = request;
    const isVision = maybeVision.taskType === "vision" && !!maybeVision.attachment;
    if (isVision && !model.capabilities.includes("image-input")) {
      return { ok: false, error: { kind: "ai-error", code: "model_unavailable", message: "Visual extraction requires an image-input capable model.", retryable: false, requestId: request.requestId, runId: request.runId, taskType: request.taskType, modelId: request.modelId } };
    }
    this.lastVisionUpload = void 0;
    const visionParts = isVision ? await (async () => {
      const att = maybeVision.attachment;
      const raw = await (0, import_promises.readFile)(absoluteDataPath(att.relativePath));
      if (att.mediaType === "image/svg+xml" || att.filename?.toLowerCase().endsWith(".svg")) {
        const prepared = await renderSvgToImage(raw);
        assertUploadableSize(prepared.finalBytes);
        this.lastVisionUpload = { originalBytes: raw.length, finalBytes: prepared.finalBytes, resized: true, mediaType: prepared.mediaType };
        return [
          {
            type: "image_url",
            image_url: { url: `data:${prepared.mediaType};base64,${prepared.buffer.toString("base64")}` }
          }
        ];
      }
      if (att.mediaType.startsWith("image/")) {
        const prepared = await prepareImage(raw, att.mediaType);
        assertUploadableSize(prepared.finalBytes);
        this.lastVisionUpload = {
          originalBytes: prepared.originalBytes,
          finalBytes: prepared.finalBytes,
          resized: prepared.resized,
          mediaType: prepared.mediaType
        };
        return [
          {
            type: "image_url",
            image_url: { url: `data:${prepared.mediaType};base64,${prepared.buffer.toString("base64")}` }
          }
        ];
      }
      if (att.mediaType === "application/pdf") {
        const pdfImages = await renderPdfToImages(raw, att.selectedPages);
        if (pdfImages.length) {
          const parts = [];
          let totalBytes = 0;
          for (const prepared of pdfImages) {
            assertUploadableSize(prepared.finalBytes);
            totalBytes += prepared.finalBytes;
            parts.push({
              type: "image_url",
              image_url: { url: `data:${prepared.mediaType};base64,${prepared.buffer.toString("base64")}` }
            });
          }
          this.lastVisionUpload = {
            originalBytes: raw.length,
            finalBytes: totalBytes,
            resized: true,
            mediaType: "image/jpeg"
          };
          return parts;
        }
        throw new Error("PDF visual extraction failed: no source pages could be rendered.");
      }
      throw new Error(`Visual extraction does not support ${att.mediaType}.`);
    })() : null;
    const userContent = isVision ? [{ type: "text", text: request.userPrompt }, ...visionParts ?? []] : request.userPrompt;
    const isFreeText = !request.responseSchema && (request.responseFormat === "chat-result" || request.responseFormat === "code-summary");
    const systemPrompt = isFreeText ? request.systemPrompt : /json/i.test(request.systemPrompt) ? request.systemPrompt : `${request.systemPrompt} Respond with valid JSON.`;
    const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(model.baseUrl) || model.runtime === "ollama" || model.runtime === "mlx-lm" || model.runtime === "llama-server";
    const jsonSchemaPayload = request.responseSchema ? { type: "json_schema", json_schema: request.responseSchema } : getJsonSchema(request.responseFormat);
    let responseFormatPayload = void 0;
    if (isFreeText) {
      responseFormatPayload = void 0;
    } else if (request.responseSchema) {
      responseFormatPayload = jsonSchemaPayload;
    } else if (isLocal && (request.responseFormat === "code-result" || request.responseFormat === "harness-step" || request.responseFormat === "vision-result" || request.responseFormat === "draft-result")) {
      responseFormatPayload = { type: "json_object" };
    } else if (jsonSchemaPayload) {
      responseFormatPayload = jsonSchemaPayload;
    }
    const messagesPayload = [
      { role: "system", content: systemPrompt }
    ];
    if (request.history && request.history.length > 0) {
      for (const h of request.history) {
        messagesPayload.push({ role: h.role, content: h.content });
      }
    }
    messagesPayload.push({ role: "user", content: userContent });
    const contextLimit = model.contextLength ?? 8192;
    const safetyMargin = 256;
    const requestedMaxTokens = request.maxTokens ?? model.maxOutputTokens ?? (isFreeText ? 1536 : 2048);
    const textMessages = isVision ? messagesPayload.map((message) => ({ ...message, content: Array.isArray(message.content) ? message.content.filter((part) => part.type === "text") : message.content })) : messagesPayload;
    const estimatedInputTokens = countTokens(JSON.stringify(textMessages)) + (isVision ? (visionParts?.length ?? 0) * estimateVisionTokens(1024, 1024) : 0);
    const maxAllowedTokens = Math.max(128, contextLimit - estimatedInputTokens - safetyMargin);
    const maxTokens = Math.min(requestedMaxTokens, maxAllowedTokens);
    const defaultTemperature = isLocal && (request.taskType === "code" || request.taskType === "vision") ? 0 : 0.2;
    const effectiveTemperature = request.temperature ?? defaultTemperature;
    const requestPayload = {
      model: model.model,
      messages: messagesPayload,
      temperature: effectiveTemperature,
      max_tokens: maxTokens
    };
    if (responseFormatPayload !== void 0) {
      requestPayload.response_format = responseFormatPayload;
    }
    if (request.reasoningEffort !== void 0) {
      requestPayload.reasoning_effort = request.reasoningEffort;
    }
    if (request.onChunk) {
      requestPayload.stream = true;
    }
    const body = JSON.stringify(requestPayload);
    const minTimeout = isLocal ? request.taskType === "code" ? 3e5 : 18e4 : 0;
    const effectiveTimeout = request.purpose === "intent_classification" ? request.timeoutMs : Math.max(request.timeoutMs ?? 0, model.requestTimeoutMs ?? 0, minTimeout) || 6e4;
    const outboundLog = {
      phase: "request",
      taskType: request.taskType,
      modelId: request.modelId,
      providerModel: model.model,
      baseUrl: model.baseUrl,
      endpoint: `${model.baseUrl}/chat/completions`,
      maxTokens,
      temperature: request.temperature ?? 0.2,
      timeoutMs: effectiveTimeout,
      purpose: request.purpose,
      reasoningEffort: request.reasoningEffort,
      systemPromptChars: request.systemPrompt.length,
      systemPromptPreview: request.systemPrompt.slice(0, 800),
      userPromptChars: typeof userContent === "string" ? userContent.length : JSON.stringify(userContent).length,
      userPromptPreview: typeof userContent === "string" ? userContent.slice(0, 2e3) : "[multipart vision]",
      visionUpload: this.lastVisionUpload ?? null,
      visionPartsCount: Array.isArray(visionParts) ? visionParts.length : 0,
      visionPartTypes: Array.isArray(visionParts) ? visionParts.map((p) => p.type) : []
    };
    logModelRequest({
      taskType: request.taskType,
      modelId: request.modelId,
      providerModel: model.model,
      requestId: request.requestId,
      maxTokens,
      temperature: request.temperature ?? 0.2,
      userPromptPreview: typeof userContent === "string" ? userContent : "[multipart vision]"
    });
    persistGatewayTrace(request.runId, request.requestId, { ...outboundLog, bodyPreview: body.slice(0, 4e3), bodyChars: body.length, parentToolCallId: request.parentToolCallId, isRetry: request.isRetry });
    let rawText = "";
    let envelope = null;
    let extractedContent = null;
    let parsedJson = null;
    let inferenceStartedAt = Date.now();
    let inferenceTtftMs = null;
    try {
      this.externalRequestCount += isLocal ? 0 : 1;
      const t0 = inferenceStartedAt = Date.now();
      const onInferenceChunk = (delta) => {
        if (inferenceTtftMs === null && delta.length > 0) inferenceTtftMs = Date.now() - t0;
        request.onChunk?.(delta);
      };
      let response;
      if (request.onChunk && this.transport.streamRequest) {
        response = await this.transport.streamRequest(
          `${model.baseUrl}/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} }, body },
          effectiveTimeout,
          onInferenceChunk
        );
      } else {
        response = await this.transport.request(
          `${model.baseUrl}/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} }, body },
          effectiveTimeout
        );
      }
      let latencyMs = Date.now() - t0;
      try {
        rawText = await response.text();
      } catch {
        rawText = "<unreadable body>";
      }
      if (request.purpose !== "intent_classification" && response.status === 400 && /response_format|json_schema|json_object|type.*must be/i.test(rawText)) {
        let retryFormat = void 0;
        if (/must be 'json_schema'|json_schema.*text|text.*json_schema/i.test(rawText) && jsonSchemaPayload && responseFormatPayload?.type !== "json_schema") {
          retryFormat = jsonSchemaPayload;
        } else {
          retryFormat = { type: "text" };
        }
        responseFormatPayload = retryFormat;
        logGatewayError(request, `provider rejected response_format, retrying with ${retryFormat?.type ?? "plain"}`, rawText.slice(0, 200));
        const retryBody = JSON.stringify({
          ...requestPayload,
          response_format: retryFormat
        });
        const retryResponse = await this.transport.request(
          `${model.baseUrl}/chat/completions`,
          { method: "POST", headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} }, body: retryBody },
          effectiveTimeout
        );
        response = retryResponse;
        try {
          rawText = await response.text();
        } catch {
          rawText = "<unreadable body>";
        }
        if (response.status === 400 && /response_format|json_schema|json_object|type.*must be/i.test(rawText)) {
          if (retryFormat?.type !== "text") {
            responseFormatPayload = { type: "text" };
            logGatewayError(request, "retrying with text response_format", rawText.slice(0, 200));
            const textBody = JSON.stringify({
              ...requestPayload,
              response_format: { type: "text" }
            });
            const textResponse = await this.transport.request(
              `${model.baseUrl}/chat/completions`,
              { method: "POST", headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} }, body: textBody },
              effectiveTimeout
            );
            response = textResponse;
            try {
              rawText = await response.text();
            } catch {
              rawText = "<unreadable body>";
            }
          }
          if (response.status === 400 && /response_format|json_schema|json_object|type.*must be/i.test(rawText)) {
            responseFormatPayload = void 0;
            logGatewayError(request, "retrying without response_format", rawText.slice(0, 200));
            const plainPayload = { ...requestPayload };
            delete plainPayload.response_format;
            const plainResponse = await this.transport.request(
              `${model.baseUrl}/chat/completions`,
              { method: "POST", headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} }, body: JSON.stringify(plainPayload) },
              effectiveTimeout
            );
            response = plainResponse;
            try {
              rawText = await response.text();
            } catch {
              rawText = "<unreadable body>";
            }
          }
        }
      }
      logModelResponse({
        taskType: request.taskType,
        requestId: request.requestId,
        status: response.status,
        latencyMs,
        chars: rawText.length
      });
      persistGatewayTrace(request.runId, request.requestId, { phase: "http_response", taskType: request.taskType, status: response.status, latencyMs, rawTextChars: rawText.length, rawText, bodyChars: body.length });
      if (response.status < 200 || response.status >= 300) {
        const detail = rawText.slice(0, 2e3);
        persistGatewayTrace(request.runId, request.requestId, { phase: "provider_error", taskType: request.taskType, status: response.status, detail, rawText });
        throw new Error(`provider rejected request (status ${response.status}, model ${model.model}, endpoint ${model.baseUrl}/chat/completions): ${detail}`);
      }
      try {
        envelope = JSON.parse(rawText);
      } catch (e) {
        logGatewayError(request, "failed to parse envelope JSON", rawText.slice(0, 500));
        persistGatewayTrace(request.runId, request.requestId, { phase: "envelope_parse_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), rawText });
        throw new Error(`provider returned non-JSON envelope: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)} \u2014 raw: ${rawText.slice(0, 1e3)}`);
      }
      const envTyped = envelope;
      const choiceMsg = envTyped.choices?.[0]?.message;
      const reasoning = choiceMsg?.reasoning ?? choiceMsg?.reasoning_content;
      extractedContent = typeof choiceMsg?.content === "string" && choiceMsg.content.trim() ? choiceMsg.content : request.purpose === "intent_classification" ? choiceMsg?.content : reasoning ?? choiceMsg?.content;
      const finishReason = envTyped.choices?.[0]?.finish_reason ?? choiceMsg?.finish_reason;
      const usage = envTyped["usage"];
      persistGatewayTrace(request.runId, request.requestId, {
        phase: "envelope",
        taskType: request.taskType,
        envelope,
        finishReason,
        usage,
        extractedContent,
        reasoning,
        extractedContentChars: typeof extractedContent === "string" ? extractedContent.length : 0
      });
      persistGatewayTrace(request.runId, request.requestId, { phase: "provider_content_raw", taskType: request.taskType, extractedContent, reasoning });
      if (request.purpose === "intent_classification") {
        if (finishReason === "length") {
          throw new Error("Intent classifier exhausted its output budget before completing JSON. Check the model's reasoning control.");
        }
        if (typeof extractedContent !== "string" || !extractedContent.trim()) {
          throw new Error("Intent classifier returned no final JSON. The provider may have spent its output budget on reasoning.");
        }
        parsedJson = parseProviderContent(extractedContent);
      } else if (request.responseFormat === "chat-result" || request.responseFormat === "code-summary") {
        if (typeof extractedContent === "string" && extractedContent.trim().length > 0) {
          const trimmed = extractedContent.trim();
          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              parsedJson = JSON.parse(trimmed);
            } catch {
              parsedJson = request.responseFormat === "code-summary" ? { summary: trimmed, verified: true } : { text: trimmed };
            }
          } else {
            parsedJson = request.responseFormat === "code-summary" ? { summary: trimmed, verified: true } : { text: trimmed };
          }
        } else {
          parsedJson = request.responseFormat === "code-summary" ? { summary: String(extractedContent ?? ""), verified: true } : { text: String(extractedContent ?? "") };
        }
      } else {
        try {
          parsedJson = parseProviderContent(extractedContent, reasoning);
        } catch (e) {
          logGatewayError(request, "parseProviderContent failed (empty/invalid JSON)", e instanceof Error ? e.message : String(e));
          persistGatewayTrace(request.runId, request.requestId, { phase: "parse_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), extractedContent, reasoning, rawText, envelope });
          throw e;
        }
      }
      persistGatewayTrace(request.runId, request.requestId, { phase: "parsed_json", taskType: request.taskType, parsedJson });
      if (request.onChunk && !this.transport.streamRequest) {
        const finalText = typeof parsedJson === "object" && parsedJson && "text" in parsedJson ? String(parsedJson.text) : String(extractedContent ?? "");
        if (finalText) {
          request.onChunk(finalText);
        }
      }
      let normalized;
      try {
        normalized = normalizeResponse(parsedJson, request);
      } catch (e) {
        logGatewayError(request, "normalizeResponse failed", e instanceof Error ? e.message : String(e));
        persistGatewayTrace(request.runId, request.requestId, { phase: "normalize_error", taskType: request.taskType, error: e instanceof Error ? e.message : String(e), parsedJson, extractedContent, rawText, envelope });
        throw e;
      }
      if (parsedJson && typeof parsedJson === "object") {
        const pj = parsedJson;
        if (typeof pj["source"] === "string" && typeof pj["filename"] === "string") {
          logGeneratedCode({
            filename: String(pj["filename"]),
            source: String(pj["source"]),
            outputMode: typeof pj["outputMode"] === "string" ? pj["outputMode"] : void 0,
            artifactKind: typeof pj["artifactKind"] === "string" ? pj["artifactKind"] : void 0,
            artifactFilename: typeof pj["artifactFilename"] === "string" ? pj["artifactFilename"] : void 0,
            expectedResult: typeof pj["expectedResult"] === "string" ? pj["expectedResult"] : void 0
          });
        } else if (typeof pj["summary"] === "string" || typeof pj["text"] === "string") {
          logModelSummary(pj["summary"] || pj["text"], typeof pj["verified"] === "boolean" ? pj["verified"] : void 0);
        } else if (Array.isArray(pj["findings"])) {
          logVisionFindings(pj["findings"]);
        }
      }
      const normalizedChars = JSON.stringify(normalized.result).length;
      recordInference({
        requestId: request.requestId,
        runId: request.runId,
        startedAt: new Date(inferenceStartedAt).toISOString(),
        purpose: request.purpose === "intent_classification" ? "classification" : request.parentToolCallId ? "delegated" : "working_turn",
        modelId: request.modelId,
        providerModel: model.model,
        streamed: Boolean(request.onChunk && this.transport.streamRequest),
        messageCount: (request.history?.length ?? 0) + 2,
        requestBodyChars: body.length,
        toolSchema: { count: 0, serializedChars: 0, estimatedTokens: 0, estimated: true },
        reasoningControl: { mode: "default", params: {} },
        ttftMs: inferenceTtftMs,
        durationMs: latencyMs,
        status: response.status,
        finishReason: finishReason ?? null,
        usage: parseProviderUsage(usage),
        outputChars: { content: normalizedChars, reasoning: typeof reasoning === "string" ? reasoning.length : 0, toolArguments: 0 },
        toolCallNames: [],
        maxTokens
      });
      persistGatewayTrace(request.runId, request.requestId, { phase: "normalized", taskType: request.taskType, latencyMs, finishReason, usage, resultChars: normalizedChars, bodyChars: body.length });
      if (request.parentToolCallId) {
        const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
        const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
        const totalTokens = usage?.total_tokens ?? promptTokens + outputTokens;
        const tele = {
          runId: request.runId,
          requestId: request.requestId,
          parentCallId: request.parentToolCallId,
          modelId: model.id,
          taskType: request.taskType,
          purpose: request.purpose,
          isRetry: Boolean(request.isRetry),
          latencyMs,
          promptTokens,
          outputTokens,
          totalTokens
        };
        for (const listener of this.delegatedInvocationListeners) {
          try {
            listener(tele);
          } catch (e) {
            console.error("[model-gateway] error in delegated invocation listener:", e);
          }
        }
      }
      return { ok: true, value: normalized };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logGatewayError(request, `gateway failed: ${msg}`);
      persistGatewayTrace(request.runId, request.requestId, { phase: "gateway_error", taskType: request.taskType, error: msg, stack: error instanceof Error ? error.stack?.slice(0, 3e3) : void 0, rawText, envelope, extractedContent, parsedJson });
      if (request.parentToolCallId) {
        const tele = {
          runId: request.runId,
          requestId: request.requestId,
          parentCallId: request.parentToolCallId,
          modelId: model.id,
          taskType: request.taskType,
          purpose: request.purpose,
          isRetry: Boolean(request.isRetry),
          latencyMs: 0,
          promptTokens: 0,
          outputTokens: 0,
          totalTokens: 0
        };
        for (const listener of this.delegatedInvocationListeners) {
          try {
            listener(tele);
          } catch (e) {
            console.error("[model-gateway] error in delegated invocation listener:", e);
          }
        }
      }
      return { ok: false, error: providerError(error, request) };
    }
  }
  async health(modelId) {
    if (modelId !== void 0) return this.healthOne(modelId);
    return Promise.all(Array.from(this.registry.values()).map((model) => this.healthOne(model.id)));
  }
  /**
   * Probe health by distinct port/endpoint to ensure duplicates don't appear.
   * Keeps PORT as index to eliminate duplicate probes, and model name as display.
   */
  async healthDistinct() {
    const distinctByEndpoint = /* @__PURE__ */ new Map();
    const entriesToProbe = [];
    for (const pool of this.endpointPool.values()) {
      for (const m of pool) {
        entriesToProbe.push(m);
      }
    }
    if (entriesToProbe.length === 0) {
      entriesToProbe.push(...this.registry.values());
    }
    for (const model of entriesToProbe) {
      if (!model.enabled) continue;
      try {
        const u = new URL(model.baseUrl);
        const port = u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
        const key = `${u.hostname}:${port}`;
        if (!distinctByEndpoint.has(key)) {
          distinctByEndpoint.set(key, {
            port,
            model
          });
        }
      } catch {
      }
    }
    if (distinctByEndpoint.size === 0) {
      return this.health();
    }
    return Promise.all(
      Array.from(distinctByEndpoint.values()).map(async ({ model, port }) => {
        const started = Date.now();
        try {
          const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : void 0;
          const response = await this.transport.request(
            `${model.baseUrl}${model.healthPath}`,
            { method: "GET", headers: { ...key ? { authorization: `Bearer ${key}` } : {} } },
            Math.min(model.requestTimeoutMs || 5e3, 4e3)
          );
          return {
            modelId: model.model,
            port,
            available: response.status >= 200 && response.status < 300,
            checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
            latencyMs: Date.now() - started
          };
        } catch (error) {
          return {
            modelId: model.model,
            port,
            available: false,
            checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
            latencyMs: Date.now() - started,
            message: error instanceof Error ? error.message : "health check failed"
          };
        }
      })
    );
  }
  /** Per-model health probe backing the `ModelClient` surface. */
  async healthOne(modelId) {
    const model = this.registry.get(modelId);
    if (!model || !model.enabled) {
      return { modelId, available: false, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), message: "model unavailable" };
    }
    const started = Date.now();
    try {
      const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : void 0;
      const response = await this.transport.request(
        `${model.baseUrl}${model.healthPath}`,
        { method: "GET", headers: { ...key ? { authorization: `Bearer ${key}` } : {} } },
        model.requestTimeoutMs
      );
      return { modelId, available: response.status >= 200 && response.status < 300, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), latencyMs: Date.now() - started };
    } catch (error) {
      return { modelId, available: false, checkedAt: (/* @__PURE__ */ new Date()).toISOString(), latencyMs: Date.now() - started, message: error instanceof Error ? error.message : "health check failed" };
    }
  }
  // Capability cache: remembers whether a provider endpoint rejected the native `tools` param
  toolParamCapabilities = /* @__PURE__ */ new Map();
  /**
   * Sovereign Workbench v2 Unified Agent Loop native function calling interface.
   * Dispatches conversation turns with native `tools` and `tool_choice: "auto"`.
   * Automatically falls back to prompt-injected schema if provider rejects `tools`.
   */
  async chatWithTools(modelId, messages, tools, options) {
    const model = this.resolveNextEndpoint(modelId);
    if (!model) {
      return {
        ok: false,
        error: {
          kind: "ai-error",
          code: "model_unavailable",
          message: `Model ${modelId} not found in active registry`,
          retryable: false,
          modelId
        }
      };
    }
    const key = model.apiKeyEnv ? process.env[model.apiKeyEnv] : void 0;
    const isLocal = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(model.baseUrl) || model.runtime === "ollama" || model.runtime === "mlx-lm" || model.runtime === "llama-server";
    const endpointKey = `${model.baseUrl}:${model.model}`;
    const knownSupportsTools = model.toolCallingFormat !== "json" && (this.toolParamCapabilities.get(endpointKey) ?? true);
    const effectiveTimeout = Math.max(options?.timeoutMs ?? 0, model.requestTimeoutMs ?? 0, 6e4);
    const requestedMaxTokens = options?.maxTokens ?? model.maxOutputTokens ?? 4096;
    const effectiveMaxTokens = isLocal ? Math.min(requestedMaxTokens, 4096) : requestedMaxTokens;
    const effectiveTemperature = options?.temperature ?? 0.2;
    const runId = options?.runId ?? "run-agent-loop";
    const requestId = (0, import_node_crypto.randomUUID)();
    if (knownSupportsTools || tools.length === 0) {
      const nativeMessages = formatMessagesForNativeTools(messages);
      const payload = {
        model: model.model,
        messages: nativeMessages,
        temperature: effectiveTemperature,
        max_tokens: effectiveMaxTokens,
        presence_penalty: 0.1
      };
      if (options?.responseSchema && tools.length === 0) payload.response_format = { type: "json_schema", json_schema: options.responseSchema };
      const reasoningControl = resolveReasoningControl();
      Object.assign(payload, reasoningControl.params);
      if (tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = options?.toolChoice ?? "auto";
      }
      if (options?.onChunk && this.transport.streamRequest) {
        payload.stream = true;
        payload.stream_options = { include_usage: true };
      }
      try {
        const body = JSON.stringify(payload);
        const t0 = Date.now();
        let ttftMs = null;
        const onStreamChunk = (delta) => {
          if (ttftMs === null && delta.length > 0) ttftMs = Date.now() - t0;
          options?.onChunk?.(delta);
        };
        let response;
        if (options?.onChunk && this.transport.streamRequest) {
          response = await this.transport.streamRequest(
            `${model.baseUrl}/chat/completions`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} },
              body
            },
            effectiveTimeout,
            onStreamChunk
          );
        } else {
          response = await this.transport.request(
            `${model.baseUrl}/chat/completions`,
            {
              method: "POST",
              headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} },
              body
            },
            effectiveTimeout
          );
        }
        if (options?.runId) {
          persistGatewayTrace(options.runId, requestId, {
            phase: "chat_turn_request",
            modelId,
            providerModel: model.model,
            mode: "native_tools",
            messagesCount: messages.length,
            toolsCount: tools.length,
            bodyPreview: body.slice(0, 4e3),
            bodyChars: body.length
          });
        }
        const rawText = await response.text();
        const durationMs = Date.now() - t0;
        if (response.status === 400 && /tools|tool_choice|unsupported parameter/i.test(rawText)) {
          this.toolParamCapabilities.set(endpointKey, false);
        } else if (response.status >= 200 && response.status < 300) {
          const envelope = JSON.parse(rawText);
          const choice = envelope.choices?.[0];
          const msg = choice?.message;
          const rawToolCalls = msg?.tool_calls;
          const parsedCalls = [];
          if (Array.isArray(rawToolCalls)) {
            for (const call of rawToolCalls) {
              if (!call || typeof call !== "object") continue;
              const callName = call.function?.name || call.name;
              if (callName) {
                const parsedArgs = parseToolCallArguments(call.function?.arguments ?? call.arguments);
                parsedCalls.push({
                  id: call.id || (0, import_node_crypto.randomUUID)(),
                  name: callName,
                  arguments: parsedArgs
                });
              }
            }
          }
          let content = typeof msg?.content === "string" && msg.content.trim() ? String(msg.content) : msg?.reasoning_content ? String(msg.reasoning_content) : msg?.content ? String(msg.content) : null;
          if (parsedCalls.length === 0 && content) {
            const embedded = extractEmbeddedToolCalls(content);
            if (embedded.toolCalls.length > 0) {
              parsedCalls.push(...embedded.toolCalls);
              content = embedded.cleanedContent;
            }
          }
          if (options?.runId) {
            const toolChars = parsedCalls.reduce((n, c2) => n + JSON.stringify(c2.arguments).length, 0);
            recordInference({
              requestId,
              runId: options.runId,
              startedAt: new Date(t0).toISOString(),
              purpose: options.purpose ?? "working_turn",
              modelId,
              providerModel: model.model,
              streamed: Boolean(payload.stream),
              messageCount: nativeMessages.length,
              requestBodyChars: body.length,
              toolSchema: { count: tools.length, serializedChars: JSON.stringify(tools).length, estimatedTokens: Math.ceil(JSON.stringify(tools).length / 4), estimated: true },
              reasoningControl,
              ttftMs,
              durationMs,
              status: response.status,
              finishReason: choice?.finish_reason ?? null,
              usage: parseProviderUsage(envelope.usage),
              outputChars: { content: typeof msg?.content === "string" ? msg.content.length : 0, reasoning: String(msg?.reasoning_content ?? "").length, toolArguments: toolChars },
              toolCallNames: parsedCalls.map((c2) => c2.name),
              maxTokens: effectiveMaxTokens
            });
            persistGatewayTrace(options.runId, requestId, {
              phase: "chat_turn_response",
              modelId,
              mode: "native_tools",
              status: response.status,
              latencyMs: durationMs,
              content,
              toolCalls: parsedCalls,
              rawTextChars: rawText.length,
              rawText: rawText.slice(0, 4e3)
            });
          }
          return {
            ok: true,
            value: {
              content,
              tool_calls: parsedCalls.length > 0 ? parsedCalls : null,
              finishReason: choice?.finish_reason ?? msg?.finish_reason ?? null,
              usage: {
                inputTokens: envelope.usage?.prompt_tokens,
                outputTokens: envelope.usage?.completion_tokens,
                durationMs
              }
            }
          };
        } else {
          return {
            ok: false,
            error: {
              kind: "ai-error",
              code: "model_rejected_request",
              message: `Provider status ${response.status}: ${rawText.slice(0, 500)}`,
              retryable: response.status >= 500,
              modelId,
              requestId,
              runId
            }
          };
        }
      } catch (err) {
        if (!/tools/i.test(err?.message ?? "")) {
          return {
            ok: false,
            error: {
              kind: "ai-error",
              code: "model_timeout",
              message: err instanceof Error ? err.message : String(err),
              retryable: true,
              modelId,
              requestId,
              runId
            }
          };
        }
      }
    }
    const transportSchema = (field) => {
      if (field.format === "multiline") return { type: "array", items: { type: "string" }, description: `${field.description} One raw string per line; retain indentation. Blank lines are empty strings.` };
      return {
        ...field,
        ...field.properties ? { properties: Object.fromEntries(Object.entries(field.properties).map(([key2, value]) => [key2, transportSchema(value)])) } : {},
        ...field.items ? { items: transportSchema(field.items) } : {}
      };
    };
    const jsonTools = tools.map((tool) => ({ ...tool, function: { ...tool.function, parameters: transportSchema(tool.function.parameters) } }));
    const toolDescriptions = jsonTools.map((t) => `- ${t.function.name}: ${t.function.description}
  Arguments schema: ${JSON.stringify(t.function.parameters)}`).join("\n\n");
    const fallbackSystemPromptAddition = `

AVAILABLE TOOLS:
${toolDescriptions}

Return JSON: {"tool_calls":[{"name": <available tool name>, "arguments": <schema fields>}], "content":""}. Emit each operation once. Multiline arguments are arrays of raw lines; preserve indentation, use empty strings for blank lines, and do not add newline escapes. ${options?.toolChoice === "required" ? "A required operation remains incomplete. Call its tool now." : "If no operation is needed, tool_calls is [] and content is your final response."}`;
    const fallbackMessages = formatMessagesForFallback(messages, fallbackSystemPromptAddition);
    try {
      const fallbackBody = JSON.stringify({
        model: model.model,
        messages: fallbackMessages,
        temperature: effectiveTemperature,
        max_tokens: effectiveMaxTokens,
        response_format: isLocal ? { type: "text" } : void 0,
        ...resolveReasoningControl().params
      });
      if (options?.runId) {
        persistGatewayTrace(options.runId, requestId, {
          phase: "chat_turn_request",
          modelId,
          providerModel: model.model,
          mode: "fallback_prompt_injection",
          messagesCount: fallbackMessages.length,
          toolsCount: tools.length,
          bodyPreview: fallbackBody.slice(0, 4e3),
          bodyChars: fallbackBody.length
        });
      }
      const t0 = Date.now();
      let response = await this.transport.request(
        `${model.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} },
          body: fallbackBody
        },
        effectiveTimeout
      );
      let rawText = await response.text();
      let durationMs = Date.now() - t0;
      if (response.status === 400 && /response_format|json_schema|json_object|type.*must be/i.test(rawText)) {
        const plainBody = JSON.stringify({
          model: model.model,
          messages: fallbackMessages,
          temperature: effectiveTemperature,
          max_tokens: effectiveMaxTokens
        });
        const retryRes = await this.transport.request(
          `${model.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...key ? { authorization: `Bearer ${key}` } : {} },
            body: plainBody
          },
          effectiveTimeout
        );
        response = retryRes;
        try {
          rawText = await response.text();
        } catch {
          rawText = "<unreadable body>";
        }
      }
      if (response.status >= 200 && response.status < 300) {
        const envelope = JSON.parse(rawText);
        const choice = envelope.choices?.[0];
        const rawContent = choice?.message?.content;
        let parsedJson = null;
        if (typeof rawContent === "string") {
          try {
            const stripped = rawContent.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
            parsedJson = parseStructuredData(stripped);
          } catch {
            parsedJson = { content: rawContent, tool_calls: null };
          }
        }
        const toolCalls = [];
        if (Array.isArray(parsedJson?.tool_calls)) {
          for (const tc of parsedJson.tool_calls) {
            if (!tc || typeof tc !== "object") continue;
            const callName = tc.name || tc.function?.name;
            if (callName) {
              toolCalls.push({
                id: tc.id || (0, import_node_crypto.randomUUID)(),
                name: callName,
                arguments: parseToolCallArguments(tc.arguments ?? tc.parameters ?? tc.function?.arguments ?? {})
              });
            }
          }
        }
        let finalContent = typeof parsedJson?.content === "string" ? parsedJson.content : toolCalls.length ? null : typeof rawContent === "string" ? rawContent : null;
        if (toolCalls.length === 0 && finalContent) {
          const embedded = extractEmbeddedToolCalls(finalContent);
          if (embedded.toolCalls.length > 0) {
            toolCalls.push(...embedded.toolCalls);
            finalContent = embedded.cleanedContent;
          }
        }
        const decodeMultiline = (value, schema) => {
          if (schema?.format === "multiline" && Array.isArray(value) && value.every((line) => typeof line === "string")) return value.join("\n");
          if (Array.isArray(value)) return value.map((item) => decodeMultiline(item, schema?.items));
          if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key2, item]) => [key2, decodeMultiline(item, schema?.properties?.[key2])]));
          return value;
        };
        for (const call of toolCalls) {
          const definition = tools.find((tool) => tool.function.name === call.name);
          call.arguments = decodeMultiline(call.arguments, definition?.function.parameters);
        }
        if (options?.runId) {
          const fallbackUsage = parseProviderUsage(envelope.usage);
          const toolChars = toolCalls.reduce((n, c2) => n + JSON.stringify(c2.arguments).length, 0);
          recordInference({
            requestId,
            runId: options.runId,
            startedAt: new Date(t0).toISOString(),
            purpose: options.purpose ?? "working_turn",
            modelId,
            providerModel: model.model,
            streamed: false,
            messageCount: fallbackMessages.length,
            requestBodyChars: fallbackBody.length,
            toolSchema: { count: tools.length, serializedChars: JSON.stringify(tools).length, estimatedTokens: Math.ceil(JSON.stringify(tools).length / 4), estimated: true },
            reasoningControl: resolveReasoningControl(),
            ttftMs: null,
            durationMs,
            status: response.status,
            finishReason: choice?.finish_reason ?? null,
            usage: fallbackUsage,
            outputChars: { content: finalContent?.length ?? 0, reasoning: 0, toolArguments: toolChars },
            toolCallNames: toolCalls.map((c2) => c2.name),
            maxTokens: effectiveMaxTokens
          });
          persistGatewayTrace(options.runId, requestId, {
            phase: "chat_turn_response",
            modelId,
            mode: "fallback_prompt_injection",
            status: response.status,
            latencyMs: durationMs,
            content: finalContent,
            toolCalls,
            rawTextChars: rawText.length,
            rawText: rawText.slice(0, 4e3)
          });
        }
        return {
          ok: true,
          value: {
            content: finalContent,
            tool_calls: toolCalls.length > 0 ? toolCalls : null,
            finishReason: choice?.finish_reason ?? null,
            usage: {
              inputTokens: envelope.usage?.prompt_tokens,
              outputTokens: envelope.usage?.completion_tokens,
              durationMs
            }
          }
        };
      }
      return {
        ok: false,
        error: {
          kind: "ai-error",
          code: "model_rejected_request",
          message: `Fallback status ${response.status}: ${rawText.slice(0, 500)}`,
          retryable: response.status >= 500,
          modelId,
          requestId,
          runId
        }
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "ai-error",
          code: "model_unavailable",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
          modelId,
          requestId,
          runId
        }
      };
    }
  }
};
function requestBase(runId, taskType, modelId, responseFormat, systemPrompt, userPrompt, timeoutMs, maxTokens, temperature, history) {
  return {
    requestId: (0, import_node_crypto.randomUUID)(),
    runId,
    taskType,
    modelId,
    responseFormat,
    systemPrompt,
    userPrompt,
    timeoutMs,
    maxTokens,
    temperature,
    history
  };
}

// backend/src/main/tools/specialist-tools.ts
var import_node_crypto2 = require("node:crypto");

// backend/src/main/run/contract.ts
var import_zod2 = require("zod");
var pathSchema = import_zod2.z.string().min(1).max(1024).refine((value) => {
  try {
    assertSafeRelativePath(value);
    return true;
  } catch {
    return false;
  }
}, "Expected a contained relative path");
function normalizeSuccessMarker(value) {
  if (value == null) return void 0;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
var SuccessMarkerSchema = import_zod2.z.string().nullish().transform((val) => normalizeSuccessMarker(val)).pipe(import_zod2.z.string().min(1).max(128).optional());
var RunContractSchema = import_zod2.z.object({
  schemaVersion: import_zod2.z.literal(1),
  runId: import_zod2.z.string().uuid(),
  createdAt: import_zod2.z.string().datetime(),
  objective: import_zod2.z.string().min(1).max(500),
  resolution: import_zod2.z.object({ status: import_zod2.z.enum(["resolved", "ambiguous", "failed"]), ambiguity: import_zod2.z.string().max(1e3).optional() }),
  routing: import_zod2.z.object({ intentType: import_zod2.z.enum(["code_modification", "file_inspection", "command_execution", "document_drafting", "pure_chat", "general_qa"]), taskType: import_zod2.z.enum(["code", "draft", "vision"]), driverModel: import_zod2.z.string().min(1), actionable: import_zod2.z.boolean() }),
  response: import_zod2.z.object({ required: import_zod2.z.boolean(), chatOnly: import_zod2.z.boolean() }),
  workspace: import_zod2.z.object({ requested: import_zod2.z.boolean(), operations: import_zod2.z.array(import_zod2.z.object({ id: import_zod2.z.string(), operation: import_zod2.z.enum(["mutate", "write", "delete", "execute"]), targetPath: pathSchema.optional() })).max(200) }),
  deliverables: import_zod2.z.array(import_zod2.z.object({ id: import_zod2.z.string(), filename: pathSchema.optional(), filenameRequired: import_zod2.z.boolean().default(false), type: import_zod2.z.enum(["docx", "xlsx", "csv", "pdf", "md", "json", "file"]), description: import_zod2.z.string().max(1e3).optional() })).max(200),
  constraints: import_zod2.z.object({ protectedPaths: import_zod2.z.array(pathSchema).max(200), restrictMutationsToTargets: import_zod2.z.boolean(), userConstraints: import_zod2.z.array(import_zod2.z.string().max(500)).max(50) }),
  acceptance: import_zod2.z.object({ validateWrittenCode: import_zod2.z.boolean(), validatedPythonDeliverables: import_zod2.z.array(pathSchema), successMarker: SuccessMarkerSchema })
});

// backend/src/main/tools/specialist-tools.ts
var import_node_fs9 = require("node:fs");
var import_node_path9 = __toESM(require("node:path"), 1);

// backend/src/main/harness/path-guard.ts
var import_node_path7 = __toESM(require("node:path"), 1);
var import_node_fs6 = require("node:fs");
var PermissionError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PermissionError";
  }
};
function resolveSafe(workspaceRoot, requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new PermissionError("path must be a non-empty string");
  }
  if (requestedPath.includes("\0")) {
    throw new PermissionError("null byte in path");
  }
  const segments = requestedPath.split(/[/\\]+/);
  if (segments.some((s) => s === ".harness_backups" || s === ".backups")) {
    throw new PermissionError(`access to backup recovery trail forbidden: ${requestedPath}`);
  }
  if (import_node_path7.default.isAbsolute(requestedPath)) {
    throw new PermissionError(`absolute path rejected: ${requestedPath}`);
  }
  let canonicalRoot;
  try {
    canonicalRoot = (0, import_node_fs6.realpathSync)(workspaceRoot);
  } catch {
    throw new PermissionError(`workspace root does not exist: ${workspaceRoot}`);
  }
  const joined = import_node_path7.default.join(canonicalRoot, requestedPath);
  let canonicalTarget;
  try {
    canonicalTarget = (0, import_node_fs6.realpathSync)(joined);
  } catch {
    let current = joined;
    const missingSegments = [];
    while (true) {
      const parent = import_node_path7.default.dirname(current);
      missingSegments.unshift(import_node_path7.default.basename(current));
      try {
        const canonicalAncestor = (0, import_node_fs6.realpathSync)(parent);
        if (canonicalAncestor !== canonicalRoot && !canonicalAncestor.startsWith(canonicalRoot + import_node_path7.default.sep)) {
          throw new PermissionError(`path escapes workspace root: ${requestedPath}`);
        }
        canonicalTarget = import_node_path7.default.join(canonicalAncestor, ...missingSegments);
        break;
      } catch (err) {
        if (err instanceof PermissionError) throw err;
        if (parent === current || parent === "." || parent === import_node_path7.default.sep) {
          throw new PermissionError(`path escapes workspace root or invalid ancestor: ${requestedPath}`);
        }
        current = parent;
      }
    }
  }
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + import_node_path7.default.sep)) {
    throw new PermissionError(`path escapes workspace root: ${requestedPath}`);
  }
  const backupDir = import_node_path7.default.join(canonicalRoot, ".harness_backups");
  const altBackupDir = import_node_path7.default.join(canonicalRoot, ".backups");
  if (canonicalTarget === backupDir || canonicalTarget.startsWith(backupDir + import_node_path7.default.sep) || canonicalTarget === altBackupDir || canonicalTarget.startsWith(altBackupDir + import_node_path7.default.sep)) {
    throw new PermissionError(`access to backup recovery trail forbidden: ${requestedPath}`);
  }
  return canonicalTarget;
}

// backend/src/main/tools/python.ts
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var exec = (0, import_node_util.promisify)(import_node_child_process.execFile);

// backend/src/main/tools/artifacts.ts
var import_exceljs = __toESM(require("exceljs"), 1);
var import_docx = require("docx");

// backend/src/main/tools/document-reader.ts
var import_node_fs7 = require("node:fs");
async function loadPdfJs2() {
  try {
    const legacy = await import(
      /* @vite-ignore */
      "pdfjs-dist/legacy/build/pdf.mjs"
    );
    if (legacy && (typeof legacy.getDocument === "function" || typeof legacy.default?.getDocument === "function")) {
      return typeof legacy.default?.getDocument === "function" ? legacy.default : legacy;
    }
  } catch {
  }
  try {
    const standard = await import(
      /* @vite-ignore */
      "pdfjs-dist"
    );
    return typeof standard.default?.getDocument === "function" ? standard.default : standard;
  } catch {
  }
  return null;
}
async function loadJSZip() {
  const mod = await import("jszip");
  return mod.default || mod;
}
function unescapeXml(str) {
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10))).replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
function parseDocxXml(rawXml) {
  if (!rawXml || typeof rawXml !== "string") return "";
  const blockRegex = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  const blocks = rawXml.match(blockRegex) || [];
  const outputBlocks = [];
  for (const block of blocks) {
    if (block.startsWith("<w:tbl")) {
      const rows = block.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
      if (rows.length === 0) continue;
      const rowStrings = [];
      let headerColumnCount = 0;
      rows.forEach((trXml, rowIdx) => {
        const cells = trXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [];
        const cellTexts = cells.map((tcXml) => {
          const textRuns = tcXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
          const cellStr = textRuns.map((t) => unescapeXml(t.replace(/<[^>]+>/g, ""))).join("").replace(/\s+/g, " ").trim();
          return cellStr || " ";
        });
        if (rowIdx === 0) {
          headerColumnCount = cellTexts.length;
          rowStrings.push(`| ${cellTexts.join(" | ")} |`);
          rowStrings.push(`| ${cellTexts.map(() => "---").join(" | ")} |`);
        } else {
          while (cellTexts.length < headerColumnCount) {
            cellTexts.push(" ");
          }
          rowStrings.push(`| ${cellTexts.join(" | ")} |`);
        }
      });
      if (rowStrings.length > 0) {
        outputBlocks.push(rowStrings.join("\n"));
      }
    } else {
      let clean = block.replace(/<w:br[^>]*\/>/g, "\n");
      clean = clean.replace(/<w:tab[^>]*\/>/g, "	");
      const textRuns = clean.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
      const pText = textRuns.map((t) => unescapeXml(t.replace(/<[^>]+>/g, ""))).join("").trim();
      if (pText.length > 0) {
        outputBlocks.push(pText);
      }
    }
  }
  return outputBlocks.join("\n\n").trim();
}
async function extractDocxText(filePathOrBuffer) {
  let buffer;
  if (typeof filePathOrBuffer === "string") {
    if (!(0, import_node_fs7.existsSync)(filePathOrBuffer)) {
      throw new Error(`DOCX file not found: ${filePathOrBuffer}`);
    }
    buffer = (0, import_node_fs7.readFileSync)(filePathOrBuffer);
  } else {
    buffer = filePathOrBuffer;
  }
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    throw new Error("Invalid DOCX format: word/document.xml not found");
  }
  const xml = await docFile.async("text");
  const extractedText = parseDocxXml(xml);
  const totalChars = extractedText.length;
  const hasText = totalChars >= 10;
  return {
    text: extractedText,
    hasText,
    totalChars
  };
}
async function extractPdfText(filePathOrBuffer) {
  let buffer;
  if (typeof filePathOrBuffer === "string") {
    if (!(0, import_node_fs7.existsSync)(filePathOrBuffer)) {
      throw new Error(`PDF file not found: ${filePathOrBuffer}`);
    }
    buffer = (0, import_node_fs7.readFileSync)(filePathOrBuffer);
  } else {
    buffer = filePathOrBuffer;
  }
  const pdfjs = await loadPdfJs2();
  if (!pdfjs) {
    throw new Error("PDF processing engine (pdfjs-dist) could not be loaded");
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true
  }).promise;
  const numPages = doc.numPages;
  const pages = [];
  let totalChars = 0;
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content.items || [];
    const textPieces = [];
    for (const item of items) {
      if (typeof item.str === "string") {
        textPieces.push(item.str);
        if (item.hasEOL) {
          textPieces.push("\n");
        }
      }
    }
    const pageRawText = textPieces.join(" ").replace(/ \n /g, "\n").replace(/ \n/g, "\n").replace(/\n /g, "\n");
    const cleanedPageText = pageRawText.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter((line, idx, arr) => line.length > 0 || idx > 0 && arr[idx - 1].length > 0).join("\n").trim();
    totalChars += cleanedPageText.length;
    pages.push({
      pageNumber: i,
      text: cleanedPageText
    });
  }
  const pageSections = pages.filter((p) => p.text.length > 0).map((p) => `--- Page ${p.pageNumber} ---
${p.text}`);
  const combinedText = pageSections.join("\n\n");
  const hasText = totalChars >= 20 && pages.every((page) => page.text.trim().length > 0);
  return {
    text: combinedText,
    pages,
    numPages,
    hasText,
    totalChars
  };
}

// backend/src/main/tools/workspace-tools.ts
var import_node_fs8 = require("node:fs");
var import_node_path8 = __toESM(require("node:path"), 1);

// backend/src/main/harness/tools/read-file.ts
var MAX_FILE_SIZE = 200 * 1024;

// backend/src/main/harness/tools/run-command.ts
var import_node_child_process2 = require("node:child_process");
var import_node_util2 = require("node:util");
var exec2 = (0, import_node_util2.promisify)(import_node_child_process2.execFile);

// backend/src/main/tools/workspace-tools.ts
function extractPathArg(args) {
  if (!args) return "";
  const candidateKeys = [
    "path",
    "filePath",
    "filepath",
    "file_path",
    "filename",
    "fileName",
    "file",
    "target",
    "destination",
    "dest",
    "targetPath",
    "target_path"
  ];
  for (const k of candidateKeys) {
    if (typeof args[k] === "string" && args[k].trim()) {
      return args[k].trim();
    }
  }
  for (const wrapper of ["parameters", "arguments", "input", "params"]) {
    const val = args[wrapper];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = extractPathArg(val);
      if (nested) return nested;
    } else if (typeof val === "string" && val.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object") {
          const nested = extractPathArg(parsed);
          if (nested) return nested;
        }
      } catch {
      }
    }
  }
  const rawStr = typeof args.raw === "string" ? args.raw : "";
  if (rawStr) {
    const m = rawStr.match(/["']?(?:path|filePath|file_path|filename|fileName|file|target)["']?\s*:\s*["']([^"'\r\n]+)["']/i);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}
function findFileInRunDirectories(runId, relPath) {
  const areas = ["output", "intermediate", "input"];
  const base = import_node_path8.default.basename(relPath);
  for (const area of areas) {
    if (relPath.startsWith(`${area}/`) || relPath.startsWith(`${area}\\`)) {
      try {
        const candidate = resolveRunPath(runId, relPath, area);
        if ((0, import_node_fs8.existsSync)(candidate)) return candidate;
      } catch {
      }
    }
  }
  for (const area of areas) {
    try {
      const areaDir = resolveRunPath(runId, area, area);
      const directCandidate = import_node_path8.default.join(areaDir, base);
      if ((0, import_node_fs8.existsSync)(directCandidate)) return directCandidate;
      if ((0, import_node_fs8.existsSync)(areaDir)) {
        const files = (0, import_node_fs8.readdirSync)(areaDir);
        const matched = files.find((f) => f === base || f.endsWith(`-${base}`));
        if (matched) {
          const matchedPath = import_node_path8.default.join(areaDir, matched);
          if ((0, import_node_fs8.existsSync)(matchedPath)) return matchedPath;
        }
      }
    } catch {
    }
  }
  return null;
}

// backend/src/main/tools/specialist-tools.ts
var extractDocumentTool = {
  name: "extract_document",
  definition: {
    type: "function",
    function: {
      name: "extract_document",
      description: "Extract source text, tables, annotations and visual evidence from an attached document or image.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "The filename of the attached document or image to inspect." },
          query: { type: "string", description: "Specific extraction instruction or focus area from the user request." }
        },
        required: ["filename"]
      }
    }
  },
  async execute(args, context) {
    const rawPath = extractPathArg(args) || String(args.filename ?? args.path ?? args.document ?? args.file ?? "");
    const cleanRawPath = rawPath.trim().replace(/^['"]|['"]$/g, "");
    if (!cleanRawPath) {
      throw new Error(`extract_document requires a filename or path parameter. Received: ${JSON.stringify(args)}`);
    }
    const query = String(args.query ?? args.prompt ?? args.instruction ?? args.focus ?? args.task ?? "Extract source text, tables, annotations and visual evidence from this document.");
    let filePath = null;
    if (context.workspaceRoot) {
      try {
        const resolved = resolveSafe(context.workspaceRoot, cleanRawPath);
        if ((0, import_node_fs9.existsSync)(resolved)) filePath = resolved;
      } catch {
      }
    }
    if (!filePath && context.runId) {
      filePath = findFileInRunDirectories(context.runId, cleanRawPath);
    }
    if (!filePath && (0, import_node_fs9.existsSync)(cleanRawPath)) {
      filePath = cleanRawPath;
    }
    if (!filePath || !(0, import_node_fs9.existsSync)(filePath)) {
      throw new Error(`Attached file "${cleanRawPath}" not found in run directories or workspace`);
    }
    const filename = import_node_path9.default.basename(filePath);
    const ext = import_node_path9.default.extname(filename).toLowerCase();
    if (ext === ".docx" || ext === ".doc") {
      const docxRes = await extractDocxText(filePath);
      const pageReferences = [{ id: "doc-1", page: 1, text: docxRes.text.slice(0, 1e3) }];
      const findings2 = [
        {
          findingId: "f-1",
          title: `Document Content: ${filename}`,
          value: docxRes.text.slice(0, 500),
          pageReferenceIds: ["doc-1"],
          confidence: "high",
          evidence: docxRes.text.slice(0, 300)
        }
      ];
      const docResult = {
        sourceText: docxRes.text,
        extractionMethod: "digital_document",
        pageReferences,
        findings: findings2
      };
      return {
        output: JSON.stringify(docResult, null, 2),
        summary: `Extracted text from Word document "${filename}" (${docxRes.totalChars} chars)`,
        intermediate: { type: "document", status: "complete", origin: "source_extracted", payload: docResult, sources: [{ filename: cleanRawPath, relation: "source" }] }
      };
    }
    if (ext === ".pdf") {
      try {
        const pdfRes = await extractPdfText(filePath);
        if (pdfRes.hasText) {
          const pageReferences = pdfRes.pages.map((p) => ({
            id: `page-${p.pageNumber}`,
            page: p.pageNumber,
            text: p.text.slice(0, 1e3)
          }));
          const findings2 = pdfRes.pages.map((p) => ({
            findingId: `finding-p${p.pageNumber}`,
            title: `Page ${p.pageNumber} Content: ${filename}`,
            value: p.text.slice(0, 500),
            pageReferenceIds: [`page-${p.pageNumber}`],
            confidence: "high",
            evidence: p.text.slice(0, 300)
          }));
          const digitalResult = {
            sourceText: pdfRes.text,
            extractionMethod: "digital_text",
            numPages: pdfRes.numPages,
            pageReferences,
            findings: findings2
          };
          return {
            output: JSON.stringify(digitalResult, null, 2),
            summary: `Extracted digital text across ${pdfRes.numPages} pages from "${filename}" (${pdfRes.totalChars} chars)`,
            intermediate: { type: "document", status: "complete", origin: "source_extracted", payload: { ...digitalResult, pages: pdfRes.pages }, sources: pdfRes.pages.map((p) => ({ filename: cleanRawPath, page: p.pageNumber, relation: "source" })) }
          };
        }
      } catch (err) {
        console.warn(`[extract_document] digital extraction failed for "${filename}", falling back to vision:`, err);
      }
    }
    if (ext === ".svg") {
      try {
        const raw = (0, import_node_fs9.readFileSync)(filePath);
        const svgText = extractSvgText(raw, null);
        if (svgText && svgText.trim().length > 0) {
          const pageReferences = [{ id: "svg-1", page: 1, text: svgText.slice(0, 1e3) }];
          const findings2 = [
            {
              findingId: "svg-f1",
              title: `Vector Drawing Content: ${filename}`,
              value: svgText.slice(0, 500),
              pageReferenceIds: ["svg-1"],
              confidence: "high",
              evidence: svgText.slice(0, 300)
            }
          ];
          const svgResult = {
            sourceText: svgText,
            extractionMethod: "digital_svg",
            pageReferences,
            findings: findings2
          };
          return {
            output: JSON.stringify(svgResult, null, 2),
            summary: `Extracted vector diagram text and annotations from SVG "${filename}" (${svgText.length} chars)`,
            intermediate: { type: "document", status: "complete", origin: "source_extracted", payload: svgResult, sources: [{ filename: cleanRawPath, relation: "source" }] }
          };
        }
      } catch (err) {
        console.warn(`[extract_document] digital SVG extraction failed for "${filename}", falling back to vision:`, err);
      }
    }
    const mediaType = ext === ".pdf" ? "application/pdf" : ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
    const entries = [...context.gateway.registry?.values() ?? []];
    const preferred = entries.find((entry2) => entry2.id === context.runContract?.routing.driverModel && entry2.enabled && entry2.capabilities.includes("image-input"));
    const imageModel = preferred ?? entries.find((entry2) => entry2.enabled && entry2.capabilities.includes("image-input"));
    if (!imageModel) throw new Error("Visual extraction requires an enabled model with image-input capability; none is configured.");
    const targetModelId = imageModel.id;
    const base = requestBase(
      context.runId,
      "vision",
      targetModelId,
      "vision-result",
      "Extract document text, tables, annotations and visual evidence accurately. Preserve source subjects, layout and page locations. Do not infer missing content.",
      query,
      6e4,
      imageModel.maxOutputTokens ?? 1024,
      imageModel.temperature ?? 0
    );
    const sourceRelativePath = import_node_path9.default.relative(dataRoot(), filePath);
    const attachmentPath = sourceRelativePath.startsWith("..") || import_node_path9.default.isAbsolute(sourceRelativePath) ? writeRunFile(context.runId, "intermediate", `${(0, import_node_crypto2.randomUUID)()}-${filename}`, (0, import_node_fs9.readFileSync)(filePath)) : sourceRelativePath;
    const req = {
      ...base,
      requestId: (0, import_node_crypto2.randomUUID)(),
      taskType: "vision",
      modelId: targetModelId,
      responseFormat: "vision-result",
      attachment: {
        attachmentId: (0, import_node_crypto2.randomUUID)(),
        filename,
        mediaType,
        sizeBytes: (0, import_node_fs9.statSync)(filePath).size,
        relativePath: attachmentPath
      },
      inputMode: "typed-scan",
      parentToolCallId: context.currentCallId
    };
    const resp = await context.gateway.execute(req);
    if (!resp.ok) {
      throw new Error(`Document extraction failed: ${resp.error.message}`);
    }
    const visionResult = resp.value.result;
    const findings = visionResult.findings ?? [];
    const summary = `Extracted ${findings.length} findings from "${filename}"`;
    return {
      output: JSON.stringify(visionResult, null, 2),
      summary,
      intermediate: { type: "document", status: "complete", origin: "model_derived", payload: visionResult, sources: [{ filename: cleanRawPath, relation: "input" }] }
    };
  }
};

// vision-smoke.ts
var output = process.argv[2];
setDataDir(import_node_path10.default.join(output, "data"));
var registry = JSON.parse((0, import_node_fs10.readFileSync)(import_node_path10.default.join(process.cwd(), "config/models.json"), "utf8")).models;
var gateway = new ModelGateway(void 0, registry);
var calls = [];
gateway.onDelegatedInvocation((event) => calls.push(event));
var results = [];
(async () => {
  for (const filename of ["image-only.pdf", "shapes.png", "geometry.svg"]) {
    const runId = (0, import_node_crypto3.randomUUID)();
    createRunDirectories(runId);
    (0, import_node_fs10.copyFileSync)(import_node_path10.default.join(output, filename), resolveRunPath(runId, "input/" + filename, "input"));
    const before = calls.length;
    const start = performance.now();
    let result;
    try {
      const observation = await extractDocumentTool.execute(
        { filename, query: "Describe the visible shapes, their colors, counts and spatial relationships. Report only what the image shows." },
        { runId, gateway, currentCallId: (0, import_node_crypto3.randomUUID)(), workspaceRoot: resolveRunPath(runId, "input", "input") }
      );
      const payload = JSON.parse(observation.output);
      const actualCalls = calls.slice(before);
      const text = JSON.stringify(payload);
      const meaningful = /blue/i.test(text) && /circle/i.test(text) && (filename === "geometry.svg" ? /green/i.test(text) && /rectang/i.test(text) : /red/i.test(text) && /triang/i.test(text));
      result = {
        filename,
        runId,
        classification: actualCalls.some((call) => call.taskType === "vision") && meaningful ? "PASS" : "FAIL",
        latencySec: (performance.now() - start) / 1e3,
        toolPath: ["extract_document", "ModelGateway.execute(vision)"],
        calls: actualCalls,
        payload,
        manualReviewRequired: true
      };
    } catch (error) {
      result = { filename, runId, classification: "FAIL", latencySec: (performance.now() - start) / 1e3, error: String(error), calls: calls.slice(before), manualReviewRequired: true };
    }
    results.push(result);
    (0, import_node_fs10.writeFileSync)(import_node_path10.default.join(output, "results.json"), JSON.stringify({ results, manualReviewRequired: true }, null, 2));
    console.log(filename + ": " + result.classification + "; " + result.latencySec.toFixed(1) + "s");
  }
  process.exitCode = results.every((result) => result.classification === "PASS") ? 0 : 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
