import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { ModelConfigRow, ModelRegistryEntry, RunEvent } from "../src/shared/contracts.js";
import { resolveSemanticIntent } from "../src/main/router/contextual-router.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { buildRegistryFromRows, loadRegistry } from "../src/main/gateway/registry.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import { RunManager } from "../src/main/run/manager.js";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import { resolveRunPath } from "../src/main/run/filesystem.js";

// Explicit live runs fail when unavailable. Ordinary unit runs report these as
// skipped, rather than claiming that an unreachable endpoint passed a live test.
describe.skipIf(process.env.WORKBENCH_LIVE_TESTS !== "1")("Live intent classification through the production gateway", () => {
  let registry: ModelRegistryEntry[];
  let tempDir: string;
  let previousDataRoot: string | undefined;
  beforeAll(() => {
    if (process.env.WORKBENCH_LIVE_MODELS_PATH) {
      registry = [...loadRegistry(process.env.WORKBENCH_LIVE_MODELS_PATH).values()];
    } else {
      // Development Electron stores its settings below data/data. Packaged app
      // callers can supply WORKBENCH_LIVE_DB_PATH. Never migrate/write app data.
      const settingsDb = new Database(process.env.WORKBENCH_LIVE_DB_PATH ?? path.resolve("data/data/workbench.db"), { readonly: true, fileMustExist: true });
      try {
        const row = settingsDb.prepare("SELECT value FROM settings WHERE key=?").get("configured_models") as { value: string } | undefined;
        if (!row) throw new Error("Live verification needs the app's configured_models setting or WORKBENCH_LIVE_MODELS_PATH.");
        registry = buildRegistryFromRows(JSON.parse(row.value) as ModelConfigRow[]);
      } finally { settingsDb.close(); }
    }
    expect(registry.some((model) => model.id === "draft-qwen3" && model.enabled)).toBe(true);
    console.log("Live classifier registry:", registry.filter((model) => model.id === "draft-qwen3"));
  });
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "workbench-live-intent-"));
    previousDataRoot = process.env.WORKBENCH_DATA_ROOT;
    process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
  });
  afterEach((context) => {
    closeDb();
    vi.restoreAllMocks();
    if (previousDataRoot === undefined) delete process.env.WORKBENCH_DATA_ROOT;
    else process.env.WORKBENCH_DATA_ROOT = previousDataRoot;
    if (context.task.result?.state === "fail") console.log("Live failure evidence:", tempDir);
    else rmSync(tempDir, { recursive: true, force: true });
  });

  it("classifies the reported attached repair as an isolated source artifact within its deadline", async () => {
    const started = Date.now();
    const intent = await resolveSemanticIntent({
      userPrompt: "This is crashing on our vendor log files. Fix it and make sure it actually works.",
      hasWorkspace: true,
      workspaceFiles: ["config.json", "fixed-vendor-log-parser.py", "notes.md", "sales.csv", "unrelated.md"],
      attachments: [
        { attachmentId: "code", filename: "broken-vendor-log-parser.py", mediaType: "text/x-python-script", sizeBytes: 677, relativePath: "input/code.py" },
        { attachmentId: "csv", filename: "vendor-maintenance-log.csv", mediaType: "text/csv", sizeBytes: 233, relativePath: "input/data.csv" },
      ],
    }, new ModelGateway(undefined, registry));
    console.log("Attached repair classification:", Date.now() - started, "ms", intent);
    expect(intent.status, intent.failureReason).toBe("resolved");
    expect(intent.driverModel).toBe("code-qwen25coder");
    expect(intent.workspaceMutationRequested).toBe(false);
    expect(intent.targetFiles).toEqual([]);
    expect(intent.expectedDeliverables.some((file) => file.type === "file" && file.filename?.endsWith(".py"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(15000);
  }, 20000);

  it("preserves explicit workspace targets and protected files", async () => {
    const intent = await resolveSemanticIntent({ userPrompt: "Update notes.md. Do not modify config.json, unrelated.md, or any other existing file.", hasWorkspace: true, workspaceFiles: ["notes.md", "config.json", "unrelated.md", "package.json"] }, new ModelGateway(undefined, registry));
    expect(intent.status, intent.failureReason).toBe("resolved");
    expect(intent.workspaceMutationRequested).toBe(true);
    expect(intent.targetFiles).toEqual(["notes.md"]);
    expect(intent.protectedPaths).toEqual(expect.arrayContaining(["config.json", "unrelated.md"]));
    expect(intent.restrictMutationsToTargets).toBe(true);
    expect(intent.expectedDeliverables).toEqual([]);
  }, 20000);

  it("keeps an explanation in chat despite a mounted workspace", async () => {
    const intent = await resolveSemanticIntent({ userPrompt: "Explain the difference between a CSV row and a column.", hasWorkspace: true, workspaceFiles: ["reader.py", "data.csv"] }, new ModelGateway(undefined, registry));
    console.log("Explanation classification:", intent);
    expect(intent.status, intent.failureReason).toBe("resolved");
    expect(intent.isActionable).toBe(false);
    expect(intent.chatResponseOnly).toBe(true);
    expect(intent.workspaceMutationRequested).toBe(false);
    expect(intent.expectedDeliverables).toEqual([]);
  }, 20000);

  it("reaches approval in RunManager before driver generation and stops cleanly on rejection", async () => {
    initDb(path.join(tempDir, "test.sqlite"));
    const gateway = new ModelGateway(undefined, registry);
    const generation = vi.spyOn(gateway, "chatWithTools");
    const workspace = path.join(tempDir, "workspace");
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, "notes.md"), "preserve workspace");
    const events: RunEvent[] = [];
    const manager = new RunManager(gateway, (event) => {
      events.push(event);
      if (event.type === "confirmation_required") {
        expect(generation).not.toHaveBeenCalled();
        void manager.confirm({ runId: event.runId, actionId: event.action.actionId, approved: false });
      }
    });
    const harness = new HarnessManager();
    harness.registerWorkspace(workspace);
    manager.setHarness(harness);
    const source = Buffer.from("def read(text):\n    raise ValueError('broken')\n");
    const uploaded = manager.registerAttachment({ filename: "broken-reader.py", mediaType: "text/x-python", sizeBytes: source.length, base64OrBuffer: source });
    const previousV2 = process.env.WORKBENCH_AGENT_V2;
    process.env.WORKBENCH_AGENT_V2 = "true";
    try {
      await manager.start({ userText: "Fix this attached reader and return a corrected Python file. Keep the workspace untouched.", attachmentTokens: [uploaded.attachment.attachmentId], groundingEnabled: false });
      await vi.waitFor(() => expect(events.some((event) => event.type === "run_state" && event.state === "cancelled")).toBe(true), { timeout: 18000 });
      expect(events.some((event) => event.type === "confirmation_required")).toBe(true);
      expect(generation).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === "tool_call" && event.tool === "retrieve_knowledge")).toBe(false);
      expect(readdirSync(workspace)).toEqual(["notes.md"]);
    } finally {
      if (previousV2 === undefined) delete process.env.WORKBENCH_AGENT_V2;
      else process.env.WORKBENCH_AGENT_V2 = previousV2;
    }
  }, 20000);

  it("delivers a genuinely repaired attachment after approval without changing the workspace", async () => {
    initDb(path.join(tempDir, "test.sqlite"));
    const gateway = new ModelGateway(undefined, registry);
    const generation = vi.spyOn(gateway, "chatWithTools");
    const workspace = path.join(tempDir, "workspace");
    mkdirSync(workspace);
    writeFileSync(path.join(workspace, "notes.md"), "preserve workspace");
    const events: RunEvent[] = [];
    const manager = new RunManager(gateway, (event) => {
      events.push(event);
      if (event.type === "confirmation_required") {
        expect(generation).not.toHaveBeenCalled();
        void manager.confirm({ runId: event.runId, actionId: event.action.actionId, approved: true });
      }
    });
    const harness = new HarnessManager();
    harness.registerWorkspace(workspace);
    manager.setHarness(harness);
    const source = Buffer.from('def read(path):\n    with open(path) as handle:\n        return [line.strip().split(",") for line in handle]\n');
    const sample = Buffer.from('name,note\n"pump","check, valve"\n\n');
    const uploaded = manager.registerAttachment({ filename: "broken-reader.py", mediaType: "text/x-python", sizeBytes: source.length, base64OrBuffer: source });
    const data = manager.registerAttachment({ filename: "sample.csv", mediaType: "text/csv", sizeBytes: sample.length, base64OrBuffer: sample });
    const previousV2 = process.env.WORKBENCH_AGENT_V2;
    process.env.WORKBENCH_AGENT_V2 = "true";
    try {
      const started = await manager.start({ userText: "Fix the attached CSV reader to handle quoted commas and ignore blank lines. Preserve read(path) returning a list of rows. Test it against the attached sample and return fixed-reader.py. Keep the workspace untouched.", attachmentTokens: [uploaded.attachment.attachmentId, data.attachment.attachmentId], groundingEnabled: false });
      await vi.waitFor(() => expect(events.some((event) => event.type === "run_state" && ["completed", "failed", "cancelled"].includes(event.state))).toBe(true), { timeout: 180000, interval: 250 });
      expect(events.filter((event) => event.type === "run_state").at(-1)).toMatchObject({ state: "completed" });
      expect(events.some((event) => event.type === "confirmation_required")).toBe(true);
      expect(generation).toHaveBeenCalled();
      expect(events.filter((event) => event.type === "confirmation_required")).toHaveLength(1);
      expect(events.some((event) => event.type === "artifact_ready" && event.artifact.filename === "fixed-reader.py")).toBe(true);
      expect(events.some((event) => event.type === "tool_call" && event.tool === "retrieve_knowledge")).toBe(false);
      expect(readdirSync(workspace)).toEqual(["notes.md"]);
      expect(readFileSync(path.join(workspace, "notes.md"), "utf8")).toBe("preserve workspace");
      const samplePath = path.join(tempDir, "check.csv");
      writeFileSync(samplePath, sample);
      const repairedPath = resolveRunPath(started.runId, "output/fixed-reader.py", "output");
      execFileSync("python3", ["-B", "-c", 'import runpy, sys; reader = runpy.run_path(sys.argv[1]); assert reader["read"](sys.argv[2]) == [["name", "note"], ["pump", "check, valve"]]', repairedPath, samplePath], { timeout: 5000 });
    } finally {
      if (previousV2 === undefined) delete process.env.WORKBENCH_AGENT_V2;
      else process.env.WORKBENCH_AGENT_V2 = previousV2;
    }
  }, 190000);
});
