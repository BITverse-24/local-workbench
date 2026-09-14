import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveSafe, PermissionError } from "../src/main/harness/path-guard.js";

describe("resolveSafe", () => {
  let root: string;

  beforeEach(() => {
    const rawRoot = path.join(os.tmpdir(), `harness-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(path.join(rawRoot, "src", "utils"), { recursive: true });
    root = realpathSync(rawRoot);
    writeFileSync(path.join(root, "README.md"), "# test");
    writeFileSync(path.join(root, "src", "index.ts"), "export {}");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves normal relative paths", () => {
    const result = resolveSafe(root, "README.md");
    expect(result).toBe(path.join(root, "README.md"));
  });

  it("resolves nested relative paths", () => {
    const result = resolveSafe(root, "src/index.ts");
    expect(result).toBe(path.join(root, "src", "index.ts"));
  });

  it("resolves workspace root itself", () => {
    const result = resolveSafe(root, ".");
    expect(result).toBe(root);
  });

  it("rejects empty path", () => {
    expect(() => resolveSafe(root, "")).toThrow(PermissionError);
  });

  it("rejects .. traversal", () => {
    expect(() => resolveSafe(root, "../../../etc/passwd")).toThrow(PermissionError);
  });

  it("rejects .. traversal inside path that escapes", () => {
    expect(() => resolveSafe(root, "src/../../..")).toThrow(PermissionError);
  });

  it("rejects absolute posix paths", () => {
    expect(() => resolveSafe(root, "/etc/passwd")).toThrow(PermissionError);
  });

  it("rejects null bytes", () => {
    expect(() => resolveSafe(root, "file\0name.txt")).toThrow(PermissionError);
  });

  it("allows non-existent child path (for write_file)", () => {
    const result = resolveSafe(root, "src/newfile.ts");
    expect(result).toBe(path.join(root, "src", "newfile.ts"));
  });

  it("allows non-existent deeply nested path (for write_file)", () => {
    const result = resolveSafe(root, "deep/nested/dir/newfile.ts");
    expect(result).toBe(path.join(root, "deep", "nested", "dir", "newfile.ts"));
  });

  it("rejects non-existent path that escapes via parent traversal", () => {
    expect(() => resolveSafe(root, "../outside/file.txt")).toThrow(PermissionError);
  });

  it("rejects symlink that escapes workspace", () => {
    const outside = path.join(os.tmpdir(), `harness-outside-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    symlinkSync(outside, path.join(root, "escape-link"));
    try {
      expect(() => resolveSafe(root, "escape-link/secret.txt")).toThrow(PermissionError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("throws when workspace root does not exist", () => {
    expect(() => resolveSafe("/nonexistent/root/path/123", "test.txt")).toThrow(PermissionError);
  });
});
