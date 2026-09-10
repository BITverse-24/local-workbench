// Phase DB.3 — DB end-to-end verification (backend/tests/db.test.ts).
// Run: npm --prefix backend run test -- db.test.ts
// Covers TASKS.md DB.3: uuid4 chat PK, seq 0,1 ordering, setting round-trip,
// cascade delete, oversized-content + abs-path rejection, 15+ tables present,
// re-launch no-op migration.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChat, deleteChat, getChat, listChats } from "../src/main/persistence/chats.js";
import {
  closeDb,
  getDb,
  getSchemaVersion,
  initDb,
  SETTING_DEFAULTS,
} from "../src/main/persistence/db.js";
import { addMessage, editMessage, listMessages } from "../src/main/persistence/messages.js";
import { assertSafeRelativePath } from "../src/main/persistence/paths.js";
import { getSetting, setSetting } from "../src/main/persistence/settings-store.js";

const UUID4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// TASKS.md DB.1 Done names these explicitly; full DDL set is asserted below too.
const REQUIRED_TABLES = ["chats", "messages", "runs", "settings"];
const ALL_DDL_TABLES = [
  "chats",
  "messages",
  "attachments",
  "message_attachments",
  "runs",
  "run_transitions",
  "routing_decisions",
  "model_calls",
  "tool_calls",
  "execution_results",
  "confirmations",
  "artifacts",
  "run_errors",
  "settings",
  "kv_meta",
];

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "workbench-db-"));
  dbPath = path.join(dir, "workbench.db");
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function tableNames(): string[] {
  return (
    getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("Phase DB — SQLite working", () => {
  it("creates schema with all tables + seeds (DB.1 Done)", () => {
    const names = tableNames();
    for (const t of REQUIRED_TABLES) expect(names).toContain(t);
    for (const t of ALL_DDL_TABLES) expect(names).toContain(t);
    expect(getSchemaVersion()).toBe("1");
    // settings defaults seeded
    for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
      expect(getSetting(k)).toEqual(v);
    }
  });

  it("chat PK matches uuid4 (DB.3)", () => {
    const id = createChat("E-201 approval note");
    expect(id).toMatch(UUID4);
    const row = getChat(id);
    expect(row?.id).toBe(id);
    expect(row?.title).toBe("E-201 approval note");
    expect(listChats().map((c) => c.id)).toContain(id);
  });

  it("two messages get seq 0,1 in order; edit sets edited_at (DB.2/DB.3)", () => {
    const chatId = createChat("seq check");
    const m1 = addMessage({ chat_id: chatId, role: "user", content: "hello" });
    const m2 = addMessage({ chat_id: chatId, role: "assistant", content: "hi back" });
    expect(m1.seq).toBe(0);
    expect(m2.seq).toBe(1);
    expect(m1.id).toMatch(UUID4);
    const rows = listMessages(chatId);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows[0]?.content).toBe("hello");
    editMessage(m1.id, "hello edited");
    const after = listMessages(chatId);
    expect(after[0]?.content).toBe("hello edited");
    expect(after[0]?.edited_at).not.toBeNull();
  });

  it("setting round-trips after update (DB.3)", () => {
    setSetting("temperature", 0.7);
    expect(getSetting("temperature")).toBe(0.7);
    setSetting("theme", "light");
    expect(getSetting("theme")).toBe("light");
  });

  it("delete chat cascade-deletes messages (DB.3)", () => {
    const chatId = createChat("cascade");
    addMessage({ chat_id: chatId, role: "user", content: "a" });
    addMessage({ chat_id: chatId, role: "user", content: "b" });
    expect(listMessages(chatId)).toHaveLength(2);
    deleteChat(chatId);
    expect(getChat(chatId)).toBeUndefined();
    expect(listMessages(chatId)).toHaveLength(0);
  });

  it("rejects oversized content >32k at app layer (DB.3)", () => {
    const chatId = createChat("oversize");
    expect(() =>
      addMessage({ chat_id: chatId, role: "user", content: "x".repeat(32 * 1024 + 1) }),
    ).toThrow();
    const ok = addMessage({ chat_id: chatId, role: "user", content: "fine" });
    expect(() => editMessage(ok.id, "y".repeat(32 * 1024 + 1))).toThrow();
  });

  it("rejects absolute / traversal relative_path at app layer (DB.3)", () => {
    expect(() => assertSafeRelativePath("C:\\runs\\a\\input\\x.pdf")).toThrow();
    expect(() => assertSafeRelativePath("C:/runs/a/input/x.pdf")).toThrow();
    expect(() => assertSafeRelativePath("/abs/runs/x.pdf")).toThrow();
    expect(() => assertSafeRelativePath("../escape/x.pdf")).toThrow();
    expect(() => assertSafeRelativePath("runs/../escape.pdf")).toThrow();
    // sane run-relative path passes
    expect(() =>
      assertSafeRelativePath("runs/abc123/input/report.pdf"),
    ).not.toThrow();
  });

  it("re-launch against same file is a no-op migration (DB.1 Done)", () => {
    const chatId = createChat("persist me");
    addMessage({ chat_id: chatId, role: "user", content: "before restart" });
    closeDb();
    initDb(dbPath); // second launch
    expect(getChat(chatId)?.id).toBe(chatId);
    expect(listMessages(chatId).map((m) => m.content)).toEqual(["before restart"]);
    expect(getSchemaVersion()).toBe("1");
  });

  it("permits artifacts of all supported kinds: docx, pdf, xlsx, csv, txt, json, md", () => {
    const chatId = createChat("artifacts test");
    const db = getDb();
    const now = new Date().toISOString();
    const runId = "test-run-1";
    db.prepare("INSERT INTO runs(id, chat_id, created_at) VALUES (?, ?, ?)").run(runId, chatId, now);

    const kinds = ["docx", "pdf", "xlsx", "csv", "txt", "json", "md"];
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i]!;
      expect(() => {
        db.prepare(
          "INSERT INTO artifacts(artifact_id, run_id, kind, filename, relative_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(`art-${i}`, runId, kind, `file.${kind}`, `runs/${runId}/output/file.${kind}`, 100, now);
      }).not.toThrow();
    }
  });

  it("migrates old artifacts table with restrictive CHECK constraint on initDb", () => {
    closeDb();
    const oldDbPath = path.join(dir, "old-workbench.db");
    const oldDb = new (require("better-sqlite3"))(oldDbPath);
    // Create old schema with restrictive check constraint
    oldDb.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, chat_id TEXT, created_at TEXT);
      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL CHECK (kind IN ('docx','pdf','xlsx','csv')),
        filename TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      INSERT INTO runs VALUES ('r1', 'c1', '2026-01-01');
      INSERT INTO artifacts VALUES ('a1', 'r1', 'csv', 'test.csv', 'runs/r1/test.csv', 10, '2026-01-01');
    `);
    oldDb.close();

    // initDb should detect outdated artifacts table and migrate it
    const db = initDb(oldDbPath);
    const existing = db.prepare("SELECT * FROM artifacts WHERE artifact_id = 'a1'").get() as any;
    expect(existing.filename).toBe("test.csv");

    // Inserting txt and md should now succeed
    expect(() => {
      db.prepare(
        "INSERT INTO artifacts(artifact_id, run_id, kind, filename, relative_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("a2", "r1", "txt", "test.txt", "runs/r1/test.txt", 10, "2026-01-01");
      db.prepare(
        "INSERT INTO artifacts(artifact_id, run_id, kind, filename, relative_path, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run("a3", "r1", "md", "test.md", "runs/r1/test.md", 10, "2026-01-01");
    }).not.toThrow();
  });
});
