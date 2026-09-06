-- Workbench SQLite schema — copy of backend/DATABASE.md §2 DDL (Phase DB.1).
-- Applied idempotently by db.ts via better-sqlite3 exec().
-- One SQLite file: backend/data/workbench.db (WAL mode). Run binaries stay on disk.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 2.1 Chats: history list (LeftSidebar) ──────────────────────────────
-- PK = uuid4 TEXT, as requested.
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,            -- uuid4, e.g. '9b1deb4d-...'
  title       TEXT NOT NULL DEFAULT 'Untitled Chat',  -- shown in ChatPanel header
  created_at  TEXT NOT NULL,               -- ISO-8601
  updated_at  TEXT NOT NULL,               -- bumped on every message/run event
  archived    INTEGER NOT NULL DEFAULT 0,  -- 0/1 soft-delete
  metadata    TEXT NOT NULL DEFAULT '{}'   -- JSON: {modelId?, temperature?} snapshot
);
CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);

-- ── 2.2 Messages: chat content (ChatArea) ──────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,            -- uuid4 (replaces Date.now() id in App.tsx:66)
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL, -- NULL = plain chat, set = agent turn
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content     TEXT NOT NULL,               -- markdown/text, ≤ 32k enforced in code
  model_id    TEXT,                        -- assistant only: which ModelId answered
  created_at  TEXT NOT NULL,
  edited_at   TEXT,                        -- set on handleEditMessage (App.tsx:87)
  seq         INTEGER NOT NULL,            -- order within chat (0,1,2…)
  UNIQUE(chat_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, seq);

-- ── 2.3 Attachments: dropped files (token registry) ────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id TEXT PRIMARY KEY,         -- opaque token returned to renderer
  chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  run_id        TEXT REFERENCES runs(id) ON DELETE SET NULL,
  filename      TEXT NOT NULL,
  media_type    TEXT NOT NULL,             -- allowlist: application/pdf, image/*, text/csv
  size_bytes    INTEGER NOT NULL,
  relative_path TEXT NOT NULL,             -- e.g. runs/<runId>/input/report.pdf (never abs)
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_chat ON attachments(chat_id);

-- message ↔ attachment join (one message can reference many files)
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(attachment_id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, attachment_id)
);

-- ── 2.4 Runs: agentic executions (from BACKEND_PLANS §7.3) ─────────────
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,        -- runId uuid4
  chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  state           TEXT NOT NULL DEFAULT 'created'
                  CHECK (state IN ('created','classifying','planning','acting',
                                   'awaiting_confirmation','completed','failed','cancelled')),
  user_text_summary TEXT NOT NULL DEFAULT '',  -- bounded ≤ 500 chars, not full prompt
  attachment_id   TEXT REFERENCES attachments(attachment_id),
  iteration_count INTEGER NOT NULL DEFAULT 0,  -- cap 8
  created_at      TEXT NOT NULL,
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_chat ON runs(chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_transitions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,               -- uuid4 per model call
  task_type  TEXT NOT NULL CHECK (task_type IN ('vision','draft','code')),
  model_id   TEXT NOT NULL,               -- vision-qwen25vl | draft-qwen3 | code-qwen25coder
  reason     TEXT NOT NULL,               -- 'scanned report' | 'compose approval note' | 'CSV/code intent'
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_calls (
  request_id TEXT PRIMARY KEY,            -- uuid4
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_type  TEXT NOT NULL,
  model_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  latency_ms INTEGER,
  ok         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool           TEXT NOT NULL CHECK (tool IN ('read_file','ocr_extract','search_knowledge',
                                               'draft_note','generate_docx','draft_code',
                                               'execute_python','generate_xlsx')),
  input_summary  TEXT NOT NULL DEFAULT '',  -- bounded, no abs paths
  result_summary TEXT NOT NULL DEFAULT '',  -- bounded ≤ 4k
  ok             INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

-- exit code / capped logs for execute_python (ai/contracts.ts:204)
CREATE TABLE IF NOT EXISTS execution_results (
  run_id      TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  exit_code   INTEGER NOT NULL,
  timed_out   INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  stdout_capped TEXT NOT NULL DEFAULT '',  -- ≤ 8k
  stderr_capped TEXT NOT NULL DEFAULT '',  -- ≤ 8k
  output_files  TEXT NOT NULL DEFAULT '[]' -- JSON array of run-relative names
);

CREATE TABLE IF NOT EXISTS confirmations (
  action_id  TEXT PRIMARY KEY,            -- uuid4
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('generate_docx','execute_python','generate_xlsx')),
  prompt     TEXT NOT NULL,               -- locked strings: 'Generate the approval-note DOCX?' etc.
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,               -- +5 min
  outcome    TEXT CHECK (outcome IN ('approved','rejected','expired','cancelled')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id   TEXT PRIMARY KEY,         -- uuid4
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('docx','pdf','xlsx','csv')),
  filename      TEXT NOT NULL,             -- e.g. approval-note-E201.docx
  relative_path TEXT NOT NULL,             -- runs/<runId>/output/…
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,               -- e.g. SOP-114
  section_id  TEXT NOT NULL,               -- e.g. 3.2
  label       TEXT NOT NULL                -- e.g. 'SOP-114 §3.2'
);

CREATE TABLE IF NOT EXISTS run_errors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,                -- AIErrorCode ai/contracts.ts:218
  message    TEXT NOT NULL,                -- safe for renderer
  retryable  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- ── 2.5 Settings (RightSidebar + app prefs) ────────────────────────────
-- Single logical row per key; upsert on change. Never stores secrets.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,             -- e.g. 'selectedModel', 'temperature'
  value      TEXT NOT NULL,                -- JSON-encoded scalar
  updated_at TEXT NOT NULL
);
-- Seed defaults on first launch:
-- ('selectedModel','"draft-qwen3"'), ('temperature','0.2'), ('theme','"dark"'),
-- ('sovereigntyVisible','true'), ('lastChatId','null')

CREATE TABLE IF NOT EXISTS kv_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- ('schema_version','1'), ('corpus_version','…')
