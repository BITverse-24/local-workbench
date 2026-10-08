# Backend Database — SQLite Schema Plan (`backend/DATABASE.md`)

> P1 runtime update: database schema version 2 adds `run_contracts` and `intermediate_results`.
> The canonical DDL is `src/main/persistence/schema.sql`; see [P1_FOUNDATION.md](P1_FOUNDATION.md)
> for record contracts, durability boundaries, migration behavior and payload storage limits.

> Writable scope: `backend/` per `AGENTS.md:1`.
> Implements persistence layer from `backend/BACKEND_PLANS.md:339` (§7.3), `backend/TASKS.md:118` (Phase 6),
> contracts `ai/contracts.ts:1`, handoff `BACKEND_HANDOFF.md:469`, arch `docs/architecture/components-and-contracts.md:137`.
> Frontend shape today: in-memory `ChatMessage{id, role, text, files?}` in `electron_app/src/App.tsx:66` — this schema is its durable replacement.

## 0. Decisions (locked)

1. **One SQLite file:** `backend/data/workbench.db` (gitignored, WAL mode). Run-scoped binaries stay on disk under `backend/data/runs/<runId>/{input,intermediate,output,logs}/` per `backend/BACKEND_PLANS.md:258` — DB stores only metadata + bounded text.
2. **Chats are the top-level session:** `chats.id TEXT PRIMARY KEY` = **uuid4** (e.g. `crypto.randomUUID()`), as requested. All messages, attachments, runs, artifacts hang off it.
3. **Runs are agentic executions inside a chat:** `runs.id` (= existing `runId`, uuid4) has `chat_id FK → chats.id`. One chat → many runs (user keeps chatting; each file-drop / send that triggers the orchestrator = one run). Simple Q&A messages without a run just live in `messages`.
4. **What is NOT stored:** API keys, absolute paths, full confidential docs, unbounded prompts/responses — per `BACKEND_HANDOFF.md:481`. Cap: `messages.content ≤ 32k`, `tool_calls.result_summary ≤ 4k`, `stdout/stderr ≤ 8k` each.
5. **Timestamps:** `TEXT ISO-8601 UTC` (`new Date().toISOString()`), Ms precision. Booleans as `INTEGER 0/1`. JSON blobs as `TEXT` (validated before write).
6. **IDs:** `chats.id`, `runs.id`, `messages.id`, `attachments.attachment_id`, `confirmations.action_id`, `artifacts.artifact_id` = uuid4 `TEXT`. `requestId` = uuid4 per model call.

## 1. ER overview

```
chats 1───* messages
  │         └───* message_attachments (metadata only, file on disk)
  ├───* runs ───* run_transitions
  │         ├───* routing_decisions
  │         ├───* model_calls
  │         ├───* tool_calls
  │         ├───* confirmations
  │         ├───* artifacts
  │         ├───* citations
  │         └───* run_errors
  └───* attachments (drop registry, token → run-relative path)
settings (single-row + per-key history optional)
kv_meta (schema version, corpus version)
```

## 2. DDL (SQLite, `better-sqlite3`)

```sql
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
```

## 3. Access patterns (prepared statements, `backend/src/main/persistence/`)

| UI / IPC need | Query |
|---|---|
| Sidebar history `workbench:getRunHistory` → rename to `getChatHistory({limit})` | `SELECT id,title,updated_at FROM chats WHERE archived=0 ORDER BY updated_at DESC LIMIT ?` |
| Open chat (ChatArea) | `SELECT * FROM messages WHERE chat_id=? ORDER BY seq ASC` + `SELECT a.* FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.attachment_id WHERE ma.message_id=?` |
| Send message (`App.tsx:62 handleSend`) | `INSERT INTO messages(id,chat_id,role,content,seq,created_at)` with `id=crypto.randomUUID()`; bump `chats.updated_at` in same transaction |
| Edit message (`App.tsx:87`) | `UPDATE messages SET content=?, edited_at=? WHERE id=?` |
| New run inside chat (`workbench:startRun`) | `INSERT INTO runs(id,chat_id,state,…)` + `INSERT INTO run_transitions` + `UPDATE chats SET updated_at=?` |
| Confirm dialog outcome | `UPDATE confirmations SET outcome=?, decided_at=? WHERE action_id=? AND run_id=?` |
| Artifact pane | `SELECT * FROM artifacts WHERE run_id=?` → `ArtifactRef{relativePath}` (main resolves to safe read stream for `getArtifact`) |
| Settings load/save (RightSidebar: model, temperature) | `SELECT value FROM settings WHERE key=?` / `INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value` |

Schema file location: `backend/src/main/persistence/schema.sql` (copy of §2 DDL); `db.ts` runs it on launch + `PRAGMA journal_mode=WAL`, seeds `settings` defaults and `kv_meta.schema_version`.

## 4. Worked example (uuid4 chats)

```sql
INSERT INTO chats(id,title,created_at,updated_at)
VALUES('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d','E-201 approval note',datetime('now'),datetime('now'));

INSERT INTO messages(id,chat_id,role,content,seq,created_at)
VALUES('7c9e6679-7425-40de-944b-e07fc1f90ae7','9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d','user','Draft the approval note for this inspection report.',0,datetime('now'));

INSERT INTO runs(id,chat_id,state,user_text_summary,created_at)
VALUES('a3e2f1c0-1111-4222-8333-abcdef123456','9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d','classifying','Draft approval note (E-201)',datetime('now'));
```

Generate in code: `import { randomUUID } from 'node:crypto'; const chatId = randomUUID(); // uuid4`.

## 5. Migration & test checklist

1. `db.ts` applies `schema.sql` idempotently; version guard via `kv_meta.schema_version`.
2. `vitest`: insert chat → post 2 messages → start run → transition → confirm → artifact; assert cascade delete removes messages on `DELETE FROM chats`.
3. Assert rejects: non-uuid accepted as TEXT but app-layer `z.string().uuid()` enforces uuid4; oversized `content` rejected; abs path in `relative_path` rejected.
4. Rehearsal: Flow A + Flow B fixtures produce rows matching `docs/demo-requirements.md:134` evidence table; `getChatHistory` returns both chats after restart.

## 6. Phase DB completion record (done)

* **DB file:** `backend/data/workbench.db` (gitignored, WAL mode). Fresh `initDb()` creates it; re-launch is a no-op migration (verified: rows persist across `closeDb()` + `initDb()`).
* **`schema_version`:** `1` (seeded in `kv_meta` via `INSERT OR IGNORE`).
* **Tables:** `SELECT name FROM sqlite_master` returns all 16 DDL tables — `chats`, `messages`, `attachments`, `message_attachments`, `runs`, `run_transitions`, `routing_decisions`, `model_calls`, `tool_calls`, `execution_results`, `confirmations`, `artifacts`, `citations`, `run_errors`, `settings`, `kv_meta` (plus `sqlite_sequence` bookkeeping) — covering the `chats`/`messages`/`runs`/`settings` Done condition in `backend/TASKS.md:23`.
* **Tests:** `npm --prefix backend run test -- db.test.ts` → 8/8 green (`backend/tests/db.test.ts`): uuid4 chat PK, `seq` 0,1 ordering + edit, setting round-trip, cascade delete, >32k content rejected, absolute/`..` `relative_path` rejected, re-launch no-op.
* **Note:** `backend/TASKS.md:22` says "all 15 tables" but the locked DDL in §2 defines 16 — all 16 are created; no schema change needed.
* **Phase 0 may begin.**
