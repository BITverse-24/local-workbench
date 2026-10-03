import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IntermediateResultInput } from "../src/shared/contracts.js";
import { initDb, closeDb, getDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { RunResultStore, RESULT_SLICE_MAX_CHARS } from "../src/main/run/result-store.js";

describe("P1 durable result store", () => {
  let root: string, dbPath: string, runId: string, store: RunResultStore;
  const input = (patch: Partial<IntermediateResultInput> = {}): IntermediateResultInput => ({ type: "text", status: "complete", origin: "source_extracted", producer: { tool: "read_file", callId: "read-1" }, summary: "A source observation", payload: "early\nmiddle\nlate", sources: [{ filename: "source.txt", section: "Observations", textSpan: { start: 0, end: 17 }, relation: "source" }], ...patch });
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "p1-result-")); dbPath = path.join(root, "db.sqlite"); initDb(dbPath); runId = createRun(createChat(), "result fixture"); store = new RunResultStore(runId, getDb(), root); });
  afterEach(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

  it("creates durable immutable records and atomic files before returning", () => {
    const first = store.registerResult(input()), second = store.registerResult(input({ payload: "transformed", origin: "model_derived", sources: [{ resultId: first.resultId, relation: "input" }] }));
    expect(first.resultId).not.toBe(second.resultId);
    expect(first.runId).toBe(runId);
    expect(store.getResult(first.resultId)).toEqual(first);
    expect(store.retrieveResultSlice(first.resultId).content).toBe("early\nmiddle\nlate");
    expect(store.listResults()).toHaveLength(2);
    expect(second.origin).toBe("model_derived");
    expect(second.sources[0].resultId).toBe(first.resultId);
    const dir = path.join(root, "runs", runId, "intermediate", "results");
    expect(readdirSync(dir).every((name) => !name.includes("pending"))).toBe(true);
  });
  it("reconstructs full payload and provenance with a newly opened SQLite/store instance", () => {
    const record = store.registerResult(input({ type: "table", payload: { rows: [{ value: 1 }, { value: 2 }] }, structuredSchema: { columns: ["value"] }, sources: [{ filename: "input.xlsx", sheet: "Readings", range: "A2:A3", page: 2, section: "Results", locator: "table-1", relation: "source" }] }));
    closeDb(); initDb(dbPath); store = new RunResultStore(runId, getDb(), root);
    expect(store.getResult(record.resultId)).toEqual(record);
    const slice = store.retrieveResultSlice(record.resultId, { mode: "json", pointer: "/rows", start: 1, count: 1 });
    expect(JSON.parse(slice.content)).toEqual([{ value: 2 }]);
    expect(store.inspectResult(record.resultId).sources).toEqual(record.sources);
  });
  it("keeps oversized observations out of SQLite while retaining exact full text", () => {
    const payload = "prefix🧪\n" + "data\n".repeat(10000) + "ending";
    const record = store.registerResult(input({ payload, summary: "s".repeat(5000) }));
    expect(record.summary).toHaveLength(512);
    expect(record.storage.sizeBytes).toBe(Buffer.byteLength(payload));
    expect(getDb().prepare("SELECT * FROM intermediate_results WHERE result_id=?").get(record.resultId)).not.toHaveProperty("payload");
    expect(readFileSync(path.join(root, "runs", runId, record.storage.relativePath), "utf8")).toBe(payload);
    expect(store.retrieveResultSlice(record.resultId, { mode: "text", offset: payload.length - 6 }).content).toBe("ending");
  });
  it("bounds text, line and structured slices and provides continuation for long selected content", () => {
    const text = store.registerResult(input({ payload: "a".repeat(9000) + "\nlast" }));
    const first = store.retrieveResultSlice(text.resultId, { mode: "lines", count: 1, maxChars: 100 });
    expect(first.content).toHaveLength(100);
    expect(first.nextOffset).toBe(100);
    expect(store.retrieveResultSlice(text.resultId, { mode: "text", offset: first.nextOffset, maxChars: 100 }).content).toHaveLength(100);
    expect(() => store.retrieveResultSlice(text.resultId, { mode: "text", maxChars: RESULT_SLICE_MAX_CHARS + 1 })).toThrow();
    const structured = store.registerResult(input({ type: "structured", payload: { rows: ["first", "middle", "last"], body: "x".repeat(4000), "a/b": { "~key": "escaped" } } }));
    expect(JSON.parse(store.retrieveResultSlice(structured.resultId, { mode: "json", pointer: "/rows", count: 2 }).content)).toEqual(["first", "middle"]);
    expect(store.retrieveResultSlice(structured.resultId, { mode: "json", pointer: "/rows", count: 2 }).nextStart).toBe(2);
    expect(store.retrieveResultSlice(structured.resultId, { mode: "json", pointer: "/body", maxChars: 20, offset: 3990 }).content).toBe("x".repeat(10));
    expect(store.retrieveResultSlice(structured.resultId, { mode: "json", pointer: "/a~1b/~0key" }).content).toBe("escaped");
    expect(() => store.retrieveResultSlice(structured.resultId, { mode: "json", pointer: "/__proto__/polluted" })).toThrow();
    expect(() => store.retrieveResultSlice(structured.resultId, { mode: "json", pointer: "/a~2b" })).toThrow();
  });
  it("persists partial status and pages source metadata separately from payload", () => {
    const record = store.registerResult(input({ status: "partial", origin: "execution", sources: Array.from({ length: 12 }, (_, page) => ({ filename: "evidence.pdf", page: page + 1, relation: "input" })) }));
    expect(store.inspectResult(record.resultId, 5, 3).sources.map((s) => s.page)).toEqual([6, 7, 8]);
    expect(store.inspectResult(record.resultId).sourceCount).toBe(12);
    expect(store.getResult(record.resultId).status).toBe("partial");
  });
  it("rejects cross-run IDs and upstream lineage, malformed IDs, path traversal and symlink aliases within isolated fixtures", () => {
    const record = store.registerResult(input());
    const other = new RunResultStore(createRun(createChat(), "other"), getDb(), root);
    expect(() => other.getResult(record.resultId)).toThrow("authorized run");
    expect(() => other.registerResult(input({ sources: [{ resultId: record.resultId, relation: "input" }] }))).toThrow("authorized run");
    expect(() => store.getResult("../../source.txt")).toThrow();
    getDb().prepare("UPDATE intermediate_results SET relative_path=? WHERE result_id=?").run("../../outside.txt", record.resultId);
    expect(() => store.retrieveResultSlice(record.resultId)).toThrow("escapes");
    getDb().prepare("UPDATE intermediate_results SET relative_path=? WHERE result_id=?").run(record.storage.relativePath, record.resultId);
    const file = path.join(root, "runs", runId, record.storage.relativePath);
    rmSync(file);
    const outsideFixture = path.join(root, "outside-fixture.txt"); writeFileSync(outsideFixture, "isolated fixture");
    symlinkSync(outsideFixture, file);
    expect(() => store.retrieveResultSlice(record.resultId)).toThrow("alias");
  });
  it("cleans files and rolls back rows when the production manifest insert fails", () => {
    getDb().exec("CREATE TRIGGER fail_result_insert BEFORE INSERT ON intermediate_results BEGIN SELECT RAISE(ABORT,'manifest failure'); END");
    expect(() => store.registerResult(input())).toThrow("manifest failure");
    expect(store.listResults()).toEqual([]);
    expect(readdirSync(path.join(root, "runs", runId, "intermediate", "results"))).toEqual([]);
  });
  it("reports file persistence failure and detects corruption instead of returning fabricated success", () => {
    const runDir = path.join(root, "runs", runId, "intermediate"); mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "results"), "blocked directory fixture");
    expect(() => store.registerResult(input())).toThrow();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM intermediate_results").get()).toEqual({ n: 0 });
    rmSync(path.join(runDir, "results"));
    const record = store.registerResult(input());
    writeFileSync(path.join(root, "runs", runId, record.storage.relativePath), "corrupt same size!");
    expect(() => store.retrieveResultSlice(record.resultId)).toThrow("mismatch");
  });
  it("rejects unserializable payload values without silently dropping data", () => {
    expect(() => store.registerResult(input({ payload: { discarded: undefined } }))).toThrow("no data was discarded");
    expect(() => store.registerResult(input({ payload: { invalid: Number.NaN } }))).toThrow("no data was discarded");
    expect(store.listResults()).toEqual([]);
  });
});
