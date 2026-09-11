import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkspaceManager } from "../src/main/harness/workspace-manager.js";

describe("WorkspaceManager", () => {
  let tmp: string;
  let manager: WorkspaceManager;

  beforeEach(() => {
    const rawTmp = path.join(os.tmpdir(), `ws-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(rawTmp, { recursive: true });
    tmp = realpathSync(rawTmp);
    manager = new WorkspaceManager();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registers a valid directory", () => {
    const info = manager.register(tmp);
    expect(info.root).toBe(tmp);
    expect(info.registeredAt).toBeTruthy();
    expect(manager.isRegistered()).toBe(true);
  });

  it("rejects non-existent path", () => {
    expect(() => manager.register("/nonexistent/dir/12345")).toThrow("does not exist");
  });

  it("rejects a file path", () => {
    const file = path.join(tmp, "notadir.txt");
    writeFileSync(file, "hi");
    expect(() => manager.register(file)).toThrow("not a directory");
  });

  it("rejects empty or invalid path input", () => {
    expect(() => manager.register("")).toThrow("non-empty string");
    expect(() => (manager as any).register(null)).toThrow("non-empty string");
  });

  it("returns null when no workspace active", () => {
    expect(manager.current()).toBeNull();
    expect(manager.isRegistered()).toBe(false);
  });

  it("requireActive throws when none active", () => {
    expect(() => manager.requireActive()).toThrow("no workspace is registered");
  });

  it("requireActive succeeds when active", () => {
    manager.register(tmp);
    const active = manager.requireActive();
    expect(active.root).toBe(tmp);
  });

  it("deregister clears workspace", () => {
    manager.register(tmp);
    expect(manager.current()).not.toBeNull();
    manager.deregister();
    expect(manager.current()).toBeNull();
    expect(manager.isRegistered()).toBe(false);
  });
});
