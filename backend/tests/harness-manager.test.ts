import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import type { RunEvent, WorkspaceEvent } from "../src/shared/contracts.js";

describe("HarnessManager", () => {
  let root: string;
  let workspaceEvents: WorkspaceEvent[];
  let runEvents: RunEvent[];
  let manager: HarnessManager;

  beforeEach(() => {
    const rawRoot = path.join(
      os.tmpdir(),
      `hm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(path.join(rawRoot, "src"), { recursive: true });
    root = realpathSync(rawRoot);

    writeFileSync(path.join(root, "package.json"), '{"name": "test-project"}\n');
    writeFileSync(path.join(root, "src", "app.ts"), 'console.log("hello world");\n');

    workspaceEvents = [];
    runEvents = [];

    manager = new HarnessManager(
      (ev) => workspaceEvents.push(ev),
      (ev) => runEvents.push(ev),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("registers workspace and emits registration + initial tree events", () => {
    const info = manager.registerWorkspace(root);
    expect(info.root).toBe(root);
    expect(manager.isWorkspaceActive()).toBe(true);

    const regEvent = workspaceEvents.find((e) => e.type === "workspace_registered");
    expect(regEvent).toBeDefined();

    const treeEvent = workspaceEvents.find((e) => e.type === "workspace_tree");
    expect(treeEvent).toBeDefined();
    if (treeEvent && treeEvent.type === "workspace_tree") {
      expect(treeEvent.entries.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("deregisters workspace and emits event", () => {
    manager.registerWorkspace(root);
    manager.deregisterWorkspace();
    expect(manager.isWorkspaceActive()).toBe(false);

    const deregEvent = workspaceEvents.find((e) => e.type === "workspace_deregistered");
    expect(deregEvent).toBeDefined();
  });

  it("executes list_dir tool and emits events", async () => {
    manager.registerWorkspace(root);
    const result = await manager.executeTool({ tool: "list_dir", args: {} }, "run-123");

    expect(result.tool).toBe("list_dir");
    if (result.tool !== "list_dir") throw new Error("expected list_dir");
    expect(result.result.length).toBeGreaterThanOrEqual(2);

    // Verify RunEvent emission
    const toolCall = runEvents.find((e) => e.type === "tool_call");
    const toolResult = runEvents.find((e) => e.type === "tool_result");
    expect(toolCall).toBeDefined();
    expect(toolResult).toBeDefined();
  });

  it("executes read_file tool", async () => {
    manager.registerWorkspace(root);
    const result = await manager.executeTool(
      { tool: "read_file", args: { path: "package.json" } },
      "run-123",
    );

    expect(result.tool).toBe("read_file");
    if (result.tool !== "read_file") throw new Error("expected read_file");
    expect(result.result).toContain("test-project");
  });

  it("executes search tool", async () => {
    manager.registerWorkspace(root);
    const result = await manager.executeTool(
      { tool: "search", args: { query: "hello world" } },
      "run-123",
    );

    expect(result.tool).toBe("search");
    if (result.tool !== "search") throw new Error("expected search");
    expect(result.result.length).toBe(1);
    expect(result.result[0].file).toBe(path.join("src", "app.ts"));
  });

  it("executes write_file tool and creates backup on overwrite", async () => {
    manager.registerWorkspace(root);
    const result = await manager.executeTool(
      { tool: "write_file", args: { path: "src/app.ts", content: 'console.log("updated");\n' } },
      "run-123",
    );

    expect(result.tool).toBe("write_file");
    if (result.tool !== "write_file") throw new Error("expected write_file");
    expect(result.result.backedUp).toBe(true);
    expect(readFileSync(path.join(root, "src", "app.ts"), "utf8")).toBe('console.log("updated");\n');
  });

  it("executes run_command tool", async () => {
    manager.registerWorkspace(root);
    const result = await manager.executeTool(
      { tool: "run_command", args: { command: "node src/app.ts" } },
      "run-123",
    );

    expect(result.tool).toBe("run_command");
    if (result.tool !== "run_command") throw new Error("expected run_command");
    expect(result.result.exitCode).toBe(0);
    expect(result.result.stdout.trim()).toBe("hello world");
  });

  it("throws when executing tool without active workspace", async () => {
    await expect(
      manager.executeTool({ tool: "list_dir", args: {} }),
    ).rejects.toThrow("no workspace is registered");
  });

  it("creates workspace artifact reference and emits artifact_ready", () => {
    manager.registerWorkspace(root);
    const artifact = manager.createWorkspaceArtifact("run-123", "package.json");

    expect(artifact.filename).toBe("package.json");
    expect(artifact.kind).toBe("json");
    expect(artifact.sizeBytes).toBeGreaterThan(0);

    const artifactEvent = runEvents.find((e) => e.type === "artifact_ready");
    expect(artifactEvent).toBeDefined();
  });
});
