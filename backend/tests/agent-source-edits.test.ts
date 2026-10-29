import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFile, fileDigest, observedRange } from "../src/main/harness/tools/edit-file.js";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";
import type { SourceReadReceipt } from "../src/shared/contracts.js";
import { agentWorkspaceActions } from "../src/main/agent/workspace-actions.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "agent-edit-")); writeFileSync(path.join(root, "app.js"), "import { load } from './storage.js';\nexport const limit = 2;\nstart(load());\n"); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function receipt(start = 0, end?: number): SourceReadReceipt {
  const bytes = readFileSync(path.join(root, "app.js"));
  return { path: "app.js", digest: fileDigest(bytes), startByte: start, endByte: end ?? bytes.length, sizeBytes: bytes.length, requestId: randomUUID(), resultId: randomUUID() };
}
function proposal() { return { path: "app.js", expectedDigest: receipt().digest, replacements: [{ old: "limit = 2", new: "limit = 3" }], requirementId: "repair-limit", reason: "Correct the limit" }; }
describe("Revision-bound exact edits", () => {
  it("pages UTF-8 bytes without splitting a code point and rejects a stale continuation", async () => {
    const text = `${"é".repeat(40)}\nsecond line\n`; writeFileSync(path.join(root, "unicode.txt"), text);
    const context = { runId: randomUUID(), workspaceRoot: root, gateway: new ModelGateway(undefined, []) };
    const read = agentWorkspaceActions.find(tool => tool.name === "read_file")!;
    const first = (await read.execute({ path: "unicode.txt", max_bytes: 65 }, context)).data as any;
    expect(first.endByte).toBe(64); expect(first.complete).toBe(false);
    const next = (await read.execute({ path: "unicode.txt", max_bytes: 65, cursor: first.nextCursor }, context)).data as any;
    expect(first.content + next.content).toBe(text); expect(next.nextCursor).toBeUndefined();
    writeFileSync(path.join(root, "unicode.txt"), `${text}!`);
    await expect(read.execute({ path: "unicode.txt", cursor: first.nextCursor }, context)).rejects.toThrow("source changed");
  });
  it("returns a directory continuation and detects listing changes", async () => {
    for (let i = 0; i < 35; i++) writeFileSync(path.join(root, `entry-${i}.txt`), String(i));
    const context = { runId: randomUUID(), workspaceRoot: root, gateway: new ModelGateway(undefined, []) };
    const list = agentWorkspaceActions.find(tool => tool.name === "list_dir")!;
    const first = (await list.execute({}, context)).data as any;
    expect(first.entries).toHaveLength(30); expect(first.nextCursor).toBeTruthy();
    writeFileSync(path.join(root, "new.txt"), "new");
    await expect(list.execute({ cursor: first.nextCursor }, context)).rejects.toThrow("source changed");
  });
  it("preserves imports and startup and retains the original backup", () => {
    const before = readFileSync(path.join(root, "app.js"), "utf8");
    const result = editFile(root, proposal(), [receipt()]);
    expect(readFileSync(path.join(root, "app.js"), "utf8")).toBe(before.replace("limit = 2", "limit = 3"));
    expect(result.beforeDigest).not.toBe(result.afterDigest);
    expect(readFileSync(path.join(root, result.backupPath!), "utf8")).toBe(before);
  });
  it("rejects stale source, unseen anchors, ambiguous anchors and overlapping edits before any write", () => {
    const original = readFileSync(path.join(root, "app.js"), "utf8"), input = proposal();
    writeFileSync(path.join(root, "app.js"), original + "// newer\n");
    expect(() => editFile(root, input, [receipt()])).toThrow("file changed");
    writeFileSync(path.join(root, "app.js"), original);
    expect(() => editFile(root, input, [receipt(0, 6)])).toThrow("outside the source ranges");
    expect(() => editFile(root, { ...input, replacements: [{ old: "load", new: "load2" }] }, [receipt()])).toThrow("exactly once");
    expect(() => editFile(root, { ...input, replacements: [{ old: "limit = 2", new: "limit = 3" }, { old: "= 2", new: "= 4" }] }, [receipt()])).toThrow("overlap");
    expect(readFileSync(path.join(root, "app.js"), "utf8")).toBe(original);
    expect(readdirSync(root)).toEqual(["app.js"]);
  });
  it("validates every replacement together and accepts contiguous observed pages", () => {
    const original = readFileSync(path.join(root, "app.js"), "utf8"), r = receipt();
    expect(observedRange([receipt(0, 40), receipt(40)], "app.js", r.digest, 0, r.sizeBytes)).toBe(true);
    expect(observedRange([receipt(0, 39), receipt(40)], "app.js", r.digest, 0, r.sizeBytes)).toBe(false);
    expect(() => editFile(root, { ...proposal(), replacements: [...proposal().replacements, { old: "missing", new: "x" }] }, [r])).toThrow("exactly once");
    expect(readFileSync(path.join(root, "app.js"), "utf8")).toBe(original);
  });
  it("binds scoped permission to the concrete operation while retaining protected paths", () => {
    const guard = new MutationPolicyGuard(), runId = randomUUID(); guard.setEnforceExplicit(runId, true);
    const scope = guard.grantScope({ runId, operation: "edit_file", targetPath: "app.js", operationDigest: "approved-operation" });
    expect(guard.isAuthorized(runId, "edit_file", { path: "app.js", operation_digest: "approved-operation" }, true)).toBe(true);
    expect(guard.isAuthorized(runId, "edit_file", { path: "app.js", operation_digest: "different-operation" }, true)).toBe(false);
    guard.setProtectedPaths(runId, ["app.js"]); guard.revokeScopes([scope.id]);
    expect(guard.isPathProtected(runId, "app.js")).toBe(true);
    expect(guard.isAuthorized(runId, "edit_file", { path: "app.js", operation_digest: "approved-operation" }, true)).toBe(false);
  });
});
