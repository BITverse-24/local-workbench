import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  listDir,
  readFile,
  search,
  writeFile,
  deleteFile,
  runCommand,
} from "../src/main/harness/tools/index.js";
import { PermissionError } from "../src/main/harness/path-guard.js";

describe("Harness Tools", () => {
  let root: string;

  beforeEach(() => {
    const rawRoot = path.join(
      os.tmpdir(),
      `harness-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(path.join(rawRoot, "src"), { recursive: true });
    mkdirSync(path.join(rawRoot, "node_modules", "pkg"), { recursive: true });
    mkdirSync(path.join(rawRoot, ".git"), { recursive: true });

    root = realpathSync(rawRoot);

    writeFileSync(path.join(root, "README.md"), "# Hello World\nTesting harness tools.\n");
    writeFileSync(path.join(root, "src", "index.ts"), "export const x = 42;\n// target search term: FIX_ME_NOW\n");
    writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── list_dir ─────────────────────────────────────────────────
  describe("listDir", () => {
    it("returns files and directories", () => {
      const entries = listDir(root);
      const names = entries.map((e) => e.name);
      expect(names).toContain("README.md");
      expect(names).toContain("src");
      expect(names).toContain(path.join("src", "index.ts"));
    });

    it("skips .git and node_modules", () => {
      const entries = listDir(root);
      const names = entries.map((e) => e.name);
      expect(names).not.toContain(".git");
      expect(names).not.toContain("node_modules");
      expect(names).not.toContain(path.join("node_modules", "pkg", "index.js"));
    });

    it("rejects path escape", () => {
      expect(() => listDir(root, "../")).toThrow(PermissionError);
      expect(() => listDir(root, "/etc")).toThrow(PermissionError);
    });

    it("respects maxDepth", () => {
      const deep = path.join(root, "level1", "level2", "level3", "level4", "level5");
      mkdirSync(deep, { recursive: true });
      writeFileSync(path.join(deep, "deep.txt"), "too deep");

      const entries = listDir(root, ".", 2);
      const deepEntry = entries.find((e) => e.name.includes("deep.txt"));
      expect(deepEntry).toBeUndefined();
    });
  });

  // ── read_file ────────────────────────────────────────────────
  describe("readFile", () => {
    it("reads file content successfully", () => {
      const content = readFile(root, "README.md");
      expect(content).toContain("# Hello World");
    });

    it("rejects path escape", () => {
      expect(() => readFile(root, "../../../etc/passwd")).toThrow(PermissionError);
      expect(() => readFile(root, "/etc/hosts")).toThrow(PermissionError);
    });

    it("rejects non-existent file", () => {
      expect(() => readFile(root, "nonexistent.txt")).toThrow();
    });

    it("rejects reading a directory", () => {
      expect(() => readFile(root, "src")).toThrow("not a file");
    });

    it("rejects files over 200KB", () => {
      const bigFile = path.join(root, "large.txt");
      writeFileSync(bigFile, "A".repeat(201 * 1024));
      expect(() => readFile(root, "large.txt")).toThrow("too large");
    });
  });

  // ── search ───────────────────────────────────────────────────
  describe("search", () => {
    it("finds matching lines across workspace", () => {
      const results = search(root, "FIX_ME_NOW");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].file).toBe(path.join("src", "index.ts"));
      expect(results[0].matchingLine).toContain("FIX_ME_NOW");
      expect(results[0].lineNumber).toBe(2);
    });

    it("returns empty array for non-matching query", () => {
      const results = search(root, "NOT_FOUND_RANDOM_XYZ_123");
      expect(results).toEqual([]);
    });

    it("ignores node_modules in search", () => {
      writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "const secret = 'IGNORE_THIS';");
      const results = search(root, "IGNORE_THIS");
      expect(results).toEqual([]);
    });

    it("rejects path escape", () => {
      expect(() => search(root, "test", "../../")).toThrow(PermissionError);
    });
  });

  // ── write_file ───────────────────────────────────────────────
  describe("writeFile", () => {
    it("creates a new file and reports diff", () => {
      const res = writeFile(root, "notes.md", "# My Notes\nLine 2\n");
      expect(res.written).toBe("notes.md");
      expect(res.backedUp).toBe(false);
      expect(res.diff).toContain("new file: 3 lines");
      expect(readFileSync(path.join(root, "notes.md"), "utf8")).toBe("# My Notes\nLine 2\n");
    });

    it("backs up before overwrite into .harness_backups", () => {
      const original = readFileSync(path.join(root, "README.md"), "utf8");
      const res = writeFile(root, "README.md", "# Replaced\nNew line\n");

      expect(res.backedUp).toBe(true);
      expect(res.backupPath).toBeTruthy();
      expect(res.backupPath).toContain(".harness_backups");

      // Verify backup content matches original
      const fullBackup = path.join(root, res.backupPath!);
      expect(existsSync(fullBackup)).toBe(true);
      expect(readFileSync(fullBackup, "utf8")).toBe(original);

      // Verify target file has new content
      expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("# Replaced\nNew line\n");
      expect(res.diff).toBeTruthy();
    });

    it("creates nested parent directories automatically", () => {
      const res = writeFile(root, "nested/sub/dir/test.txt", "content");
      expect(res.written).toBe("nested/sub/dir/test.txt");
      expect(readFileSync(path.join(root, "nested/sub/dir/test.txt"), "utf8")).toBe("content");
    });

    it("rejects path escape", () => {
      expect(() => writeFile(root, "../outside.txt", "content")).toThrow(PermissionError);
      expect(() => writeFile(root, "/tmp/bad.txt", "content")).toThrow(PermissionError);
    });
  });

  // ── delete_file ───────────────────────────────────────────────
  describe("deleteFile", () => {
    it("deletes a file and creates a backup in .harness_backups", () => {
      const original = readFileSync(path.join(root, "README.md"), "utf8");
      const res = deleteFile(root, "README.md");

      expect(res.deleted).toBe("README.md");
      expect(res.backedUp).toBe(true);
      expect(res.backupPath).toBeTruthy();
      expect(existsSync(path.join(root, "README.md"))).toBe(false);

      // Verify backup exists with original content
      const fullBackup = path.join(root, res.backupPath!);
      expect(existsSync(fullBackup)).toBe(true);
      expect(readFileSync(fullBackup, "utf8")).toBe(original);
    });

    it("throws when deleting non-existent file", () => {
      expect(() => deleteFile(root, "non-existent.txt")).toThrow("does not exist");
    });

    it("rejects deleting workspace root directory", () => {
      expect(() => deleteFile(root, ".")).toThrow("Cannot delete workspace root directory");
    });

    it("rejects path escape", () => {
      expect(() => deleteFile(root, "../outside.txt")).toThrow(PermissionError);
      expect(() => deleteFile(root, "/etc/passwd")).toThrow(PermissionError);
    });
  });

  // ── run_command ──────────────────────────────────────────────
  describe("runCommand", () => {
    it("executes a simple command with exitCode 0", async () => {
      const res = await runCommand(root, "echo 'hello from harness'");
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("hello from harness");
      expect(res.timedOut).toBe(false);
    });

    it("captures non-zero exit code", async () => {
      const res = await runCommand(root, "exit 7");
      expect(res.exitCode).toBe(7);
    });

    it("executes inside workspace directory as cwd", async () => {
      const res = await runCommand(root, "pwd");
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe(root);
    });

    it("handles command timeout", async () => {
      const res = await runCommand(root, "sleep 5", 300);
      expect(res.timedOut).toBe(true);
      expect(res.exitCode).not.toBe(0);
    });

    it("rejects empty command", async () => {
      await expect(runCommand(root, "")).rejects.toThrow("non-empty string");
    });
  });
});
