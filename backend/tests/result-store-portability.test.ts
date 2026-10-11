import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const controls = vi.hoisted(() => ({ fail: "", hardlinksUnsupported: false, syncedDirectories: 0, syncedFiles: 0 }));
vi.mock("node:fs", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...fs,
    linkSync: (source: string, target: string) => {
      if (controls.hardlinksUnsupported) throw Object.assign(new Error("links unsupported"), { code: "EPERM" });
      return fs.linkSync(source, target);
    },
    fsyncSync: (fd: number) => {
      const directory = fs.fstatSync(fd).isDirectory();
      if (directory) controls.syncedDirectories++; else controls.syncedFiles++;
      if ((directory && controls.fail === "directory") || (!directory && controls.fail === "file")) {
        throw Object.assign(new Error("injected sync failure"), { code: "EPERM", syscall: "fsync" });
      }
      return fs.fsyncSync(fd);
    },
  };
});
import { closeDb, getDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { ToolDispatcher } from "../src/main/agent/tool-dispatcher.js";
import { readFileTool } from "../src/main/tools/workspace-tools.js";
import { retrieveResultTool } from "../src/main/tools/result-retrieval.js";
const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string, runId: string, store: RunResultStore;
const input = { type: "text" as const, status: "complete" as const, origin: "source_extracted" as const,
  producer: { tool: "read_file", callId: "read" }, summary: "Source read", payload: "original source" };
const platform = (value: string) => Object.defineProperty(process, "platform", { configurable: true, value });
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "result-portability-")); initDb(path.join(root, "db.sqlite"));
  runId = createRun(createChat(), "Portability test"); store = new RunResultStore(runId, getDb(), root);
  Object.assign(controls, { fail: "", hardlinksUnsupported: false, syncedDirectories: 0, syncedFiles: 0 });
});
afterEach(() => { Object.defineProperty(process, "platform", descriptor); closeDb(); rmSync(root, { recursive: true, force: true }); });
describe("Result storage across operating systems", () => {
  it("reads, registers and retrieves on Windows without syncing a directory", async () => {
    platform("win32"); controls.fail = "directory";
    writeFileSync(path.join(root, "source.md"), input.payload);
    const context = { runId, workspaceRoot: root, gateway: {} as any, resultStore: store };
    const dispatcher = new ToolDispatcher([readFileTool, retrieveResultTool]);
    const [read] = await dispatcher.dispatchConcurrent([{ id: "read", name: "read_file", arguments: { path: "source.md" } }], context);
    expect(read.result.ok).toBe(true);
    const resultId = read.result.resultRef!.resultId;
    const [retrieved] = await dispatcher.dispatchConcurrent([{ id: "retrieve", name: "retrieve_result", arguments: { result_id: resultId } }], context);
    expect(retrieved.result.ok).toBe(true); expect(retrieved.result.output).toContain(input.payload);
    expect(store.verifyIntegrity(resultId).valid).toBe(true);
    expect(controls.syncedDirectories).toBe(0); expect(controls.syncedFiles).toBe(2);
    closeDb(); initDb(path.join(root, "db.sqlite"));
    expect(new RunResultStore(runId, getDb(), root).retrieveResultSlice(resultId).content).toBe(input.payload);
  });
  it("uses exclusive publication on Windows volumes without hard links", () => {
    platform("win32"); controls.hardlinksUnsupported = true;
    const record = store.registerResult(input);
    expect(store.retrieveResultSlice(record.resultId).content).toBe(input.payload);
    expect(store.verifyIntegrity(record.resultId).valid).toBe(true);
    expect(readdirSync(path.join(root, "runs", runId, "intermediate", "results"))).toHaveLength(1);
  });
  it.each(["darwin", "linux"])("syncs the containing directory on %s", host => {
    platform(host); store.registerResult(input);
    expect(controls.syncedDirectories).toBe(1); expect(controls.syncedFiles).toBe(1);
  });
  it("keeps real POSIX directory-sync failures visible and cleans up", () => {
    platform("linux"); controls.fail = "directory";
    expect(() => store.registerResult(input)).toThrow(/sync payload directory/);
    expect(store.listResults()).toEqual([]);
    expect(readdirSync(path.join(root, "runs", runId, "intermediate", "results"))).toEqual([]);
  });
  it("reports a real Windows payload-sync failure without a mutation warning", async () => {
    platform("win32"); controls.fail = "file"; const events: any[] = [];
    writeFileSync(path.join(root, "source.md"), input.payload);
    const [result] = await new ToolDispatcher([readFileTool]).dispatchConcurrent([{ id: "read", name: "read_file", arguments: { path: "source.md" } }],
      { runId, workspaceRoot: root, gateway: {} as any, resultStore: store, emitRunEvent: e => events.push(e) });
    expect(result.result.ok).toBe(false);
    if (!result.result.ok) {
      expect(result.result.error.code).toBe("persistence_failure");
      expect(result.result.error.message).toContain("sync payload file");
      expect(result.result.error.message).toContain("did not modify workspace files");
      expect(result.result.error.message).not.toContain("Side effects may");
    }
    expect(events.filter(e => e.type === "tool_result").every(e => e.ok === false)).toBe(true);
    expect(readFileSync(path.join(root, "source.md"), "utf8")).toBe(input.payload);
    expect(store.listResults()).toEqual([]);
    expect(readdirSync(path.join(root, "runs", runId, "intermediate", "results"))).toEqual([]);
  });
});
