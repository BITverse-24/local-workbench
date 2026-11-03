import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "../src/main/harness/tools/run-command.js";
import { fileDigest } from "../src/main/harness/tools/edit-file.js";
import { captureAgentVerificationManifest, type AgentTestOverlay } from "../src/main/agent/test-verification.js";

describe("shadow-verification", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "shadow-test-root-"));
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  it("applies overlay in temp test workspace while leaving real workspace untouched", async () => {
    // 1. Setup workspace with real code and test
    const pkg = JSON.stringify({ name: "shadow-test", type: "module" });
    const realCode = "export function multiply(a, b) {\n  return a + b;\n}\n"; // broken
    const fixedCode = "export function multiply(a, b) {\n  return a * b;\n}\n"; // fixed overlay
    const testCode = `
import test from 'node:test';
import assert from 'node:assert';
import { multiply } from './src/math.js';
test('multiply', () => {
  assert.strictEqual(multiply(3, 4), 12);
});
`;

    writeFileSync(path.join(root, "package.json"), pkg, "utf8");
    const srcDir = path.join(root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(path.join(srcDir, "math.js"), realCode, "utf8");
    writeFileSync(path.join(root, "math.test.js"), testCode, "utf8");

    const sourceDigest = fileDigest(Buffer.from(realCode, "utf8"));
    const fixedBytes = Buffer.from(fixedCode, "utf8");
    const overlay: AgentTestOverlay = {
      path: "src/math.js",
      sourceDigest,
      bytes: fixedBytes,
      digest: fileDigest(fixedBytes)
    };

    const manifest = captureAgentVerificationManifest(root);

    // Run test command with overlay
    const res = await runCommand(root, "node --test math.test.js", 60000, undefined, {
      planId: "shadow-plan-1",
      command: "node --test math.test.js",
      phase: "related",
      runner: "node",
      suiteRoot: root,
      workspaceManifestSha256: manifest.sha256,
      sourceManifest: manifest.files,
      changedTestPaths: [],
      reportFormat: "tap",
      testFiles: ["math.test.js"],
      overlay: [overlay]
    });

    // The test in the temp work copy used fixedCode, so tests passed!
    expect(res.exitCode).toBe(0);
    expect(res.verification?.overlay).toBeDefined();
    expect((res.verification?.overlay as any)?.[0].overlayDigest).toBe(overlay.digest);

    // The real workspace code MUST remain UNTOUCHED!
    expect(readFileSync(path.join(srcDir, "math.js"), "utf8")).toBe(realCode);
  });

  it("rejects overlay targeting test files", async () => {
    writeFileSync(path.join(root, "package.json"), "{}", "utf8");
    writeFileSync(path.join(root, "math.test.js"), "test", "utf8");

    const overlay: AgentTestOverlay = {
      path: "math.test.js",
      sourceDigest: fileDigest(Buffer.from("test", "utf8")),
      bytes: Buffer.from("cheating", "utf8"),
      digest: fileDigest(Buffer.from("cheating", "utf8"))
    };

    const manifest = captureAgentVerificationManifest(root);

    await expect(runCommand(root, "node --version", 60000, undefined, {
      planId: "test-plan",
      command: "node --version",
      phase: "related",
      runner: "node",
      suiteRoot: root,
      workspaceManifestSha256: manifest.sha256,
      sourceManifest: manifest.files,
      changedTestPaths: [],
      reportFormat: "tap",
      testFiles: [],
      overlay: [overlay]
    })).rejects.toThrow(/cannot be a test file/);
  });
});
