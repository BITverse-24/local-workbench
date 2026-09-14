import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import { registerWorkspaceHandlers } from "../src/main/ipc/handlers.js";
import { IPC_WORKSPACE } from "../src/main/ipc/channels.js";
import type { IpcRegistrar } from "../src/main/ipc/handlers.js";

class FakeIpcMain implements IpcRegistrar {
  private handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
    return handler(null, ...args);
  }
}

describe("Harness IPC Handlers", () => {
  let root: string;
  let fakeIpc: FakeIpcMain;
  let harness: HarnessManager;

  beforeEach(() => {
    const rawRoot = path.join(
      os.tmpdir(),
      `harness-ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(path.join(rawRoot, "src"), { recursive: true });
    root = realpathSync(rawRoot);

    writeFileSync(path.join(root, "README.md"), "# IPC Test\n");
    writeFileSync(path.join(root, "src", "main.ts"), "console.log('ipc works');\n");

    fakeIpc = new FakeIpcMain();
    harness = new HarnessManager();
    registerWorkspaceHandlers(fakeIpc, harness);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("registers workspace via IPC", async () => {
    const res = (await fakeIpc.invoke(IPC_WORKSPACE.REGISTER, { dirPath: root })) as any;
    expect(res.root).toBe(root);

    const current = (await fakeIpc.invoke(IPC_WORKSPACE.GET_CURRENT)) as any;
    expect(current.root).toBe(root);
  });

  it("lists directory via IPC", async () => {
    await fakeIpc.invoke(IPC_WORKSPACE.REGISTER, { dirPath: root });
    const res = (await fakeIpc.invoke(IPC_WORKSPACE.LIST_DIR, {})) as any;
    expect(res.tool).toBe("list_dir");
    expect(res.result.length).toBeGreaterThanOrEqual(2);
  });

  it("reads file via IPC", async () => {
    await fakeIpc.invoke(IPC_WORKSPACE.REGISTER, { dirPath: root });
    const res = (await fakeIpc.invoke(IPC_WORKSPACE.READ_FILE, { path: "README.md" })) as any;
    expect(res.tool).toBe("read_file");
    expect(res.result).toContain("# IPC Test");
  });

  it("searches via IPC", async () => {
    await fakeIpc.invoke(IPC_WORKSPACE.REGISTER, { dirPath: root });
    const res = (await fakeIpc.invoke(IPC_WORKSPACE.SEARCH, { query: "ipc works" })) as any;
    expect(res.tool).toBe("search");
    expect(res.result.length).toBe(1);
    expect(res.result[0].file).toBe(path.join("src", "main.ts"));
  });

  it("writes file via IPC", async () => {
    await fakeIpc.invoke(IPC_WORKSPACE.REGISTER, { dirPath: root });
    const res = (await fakeIpc.invoke(IPC_WORKSPACE.WRITE_FILE, {
      path: "new.txt",
      content: "via ipc",
    })) as any;
    expect(res.tool).toBe("write_file");
    expect(res.result.written).toBe("new.txt");
  });

  it("runs command via IPC", async () => {
    await fakeIpc.invoke(IPC_WORKSPACE.REGISTER, { dirPath: root });
    const res = (await fakeIpc.invoke(IPC_WORKSPACE.RUN_COMMAND, { command: "node src/main.ts" })) as any;
    expect(res.tool).toBe("run_command");
    expect(res.result.exitCode).toBe(0);
    expect(res.result.stdout.trim()).toBe("ipc works");
  });

  it("deregisters workspace via IPC", async () => {
    await fakeIpc.invoke(IPC_WORKSPACE.REGISTER, { dirPath: root });
    await fakeIpc.invoke(IPC_WORKSPACE.DEREGISTER);
    const current = (await fakeIpc.invoke(IPC_WORKSPACE.GET_CURRENT)) as any;
    expect(current).toBeNull();
  });

  it("rejects path escape via IPC", async () => {
    await fakeIpc.invoke(IPC_WORKSPACE.REGISTER, { dirPath: root });
    await expect(
      fakeIpc.invoke(IPC_WORKSPACE.READ_FILE, { path: "../../../etc/passwd" }),
    ).rejects.toThrow();
  });
});
