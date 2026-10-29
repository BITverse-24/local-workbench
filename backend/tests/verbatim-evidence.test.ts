import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequirement } from "../src/shared/contracts.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";
import { agentWorkspaceActions } from "../src/main/agent/workspace-actions.js";
import { verifyVerbatimChecks } from "../src/main/agent/verbatim-evidence.js";
import { agentInterpretationResponseSchema, parseTaskInterpretation } from "../src/main/agent/task-interpretation.js";
import { Validator } from "jsonschema";
import { fileDigest, MAX_AGENT_SOURCE_BYTES } from "../src/main/harness/tools/edit-file.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import { createChat } from "../src/main/persistence/chats.js";
import { createRun } from "../src/main/run/store.js";
import { RunResultStore } from "../src/main/run/result-store.js";
import { dataRoot, setDataDir } from "../src/main/run/filesystem.js";

let temporary: string, previous: string, workspace: string, context: ToolExecutionContext;
const source = "const café = 'आ';\r\n";
const requirement: AgentRequirement = { id: "r-literal", kind: "inspect", description: "Report the exact file content", source: { messageId: "00000000-0000-4000-8000-000000000001", start: 0, end: 1, quote: "x" }, mandatory: true, dependencies: [], state: "active", acceptance: [{ id: "check-literal", description: "Preserve the source bytes", kind: "inspection", operation: "verbatim_source", path: "sample.txt" }] };
beforeEach(() => {
  temporary = mkdtempSync(path.join(tmpdir(), "verbatim-evidence-")); previous = dataRoot(); setDataDir(temporary);
  workspace = path.join(temporary, "workspace"); mkdirSync(workspace); writeFileSync(path.join(workspace, "sample.txt"), source);
  initDb(path.join(temporary, "db.sqlite")); const runId = createRun(createChat(), "Read source");
  context = { runId, workspaceRoot: workspace, gateway: {} as any, resultStore: new RunResultStore(runId) };
});
afterEach(() => { closeDb(); setDataDir(previous); rmSync(temporary, { recursive: true, force: true }); });
const checks = (answer: string) => verifyVerbatimChecks(requirement, context, context.resultStore!.listResults({ limit: 50 }), answer)[0];
async function observe(args: Record<string, unknown> = {}) {
  const result = await agentWorkspaceActions.find(tool => tool.name === "read_file")!.execute({ path: "sample.txt", ...args }, context);
  context.resultStore!.registerResult({ ...result.intermediate!, producer: { tool: "read_file", callId: randomUUID() }, summary: result.summary });
  return result.data as { nextCursor?: string };
}

describe("Host literal source evidence", () => {
  it("requires an actual complete observation before accepting even an exact guessed answer", () => {
    expect(checks(source)).toMatchObject({ passed: false, needsSource: true });
  });
  it("compares actual Unicode bytes and line endings, including a literal Markdown quote", async () => {
    await observe();
    expect(checks(source)).toMatchObject({ passed: true, sourceDigest: fileDigest(source) });
    expect(checks(`\`\`\`js\n${source}\`\`\``).passed).toBe(true);
    expect(checks(source.replace("\r\n", "\n")).passed).toBe(false);
    expect(checks("different source\r\n").passed).toBe(false);
    expect(checks(source.trimEnd()).passed).toBe(false);
  });
  it("requires every source byte across read pages", async () => {
    const content = "line λ\n".repeat(30); writeFileSync(path.join(workspace, "sample.txt"), content);
    let page = await observe({ max_bytes: 64 });
    expect(checks(content)).toMatchObject({ passed: false, needsSource: true });
    while (page.nextCursor) page = await observe({ cursor: page.nextCursor, max_bytes: 64 });
    expect(checks(content).passed).toBe(true);
  });
  it("rejects stale observations and accepts a fresh read of the new revision", async () => {
    await observe(); writeFileSync(path.join(workspace, "sample.txt"), "new source\n");
    expect(checks(source)).toMatchObject({ passed: false, needsSource: true });
    await observe(); expect(checks("new source\n").passed).toBe(true);
  });
  it("does not trust stored content that conflicts with the actual source ranges", async () => {
    context.resultStore!.registerResult({ type: "structured", status: "complete", origin: "source_extracted", producer: { tool: "read_file", callId: randomUUID() }, summary: "Invalid source payload", payload: { sourcePage: true, path: "sample.txt", digest: fileDigest(source), startByte: 0, endByte: Buffer.byteLength(source), sizeBytes: Buffer.byteLength(source), content: "wrong bytes", complete: true } });
    expect(checks(source)).toMatchObject({ passed: false, needsSource: true });
  });
  it("does not treat an empty file as a match for arbitrary nonempty prose", async () => {
    writeFileSync(path.join(workspace, "sample.txt"), ""); await observe();
    expect(checks("unrelated answer").passed).toBe(false);
    expect(checks("```\n```").passed).toBe(true);
  });
  it("rejects a source that grows beyond the observation limit", async () => {
    await observe(); writeFileSync(path.join(workspace, "sample.txt"), Buffer.alloc(MAX_AGENT_SOURCE_BYTES + 1));
    expect(checks(source)).toMatchObject({ passed: false, needsSource: true, reason: expect.stringContaining("4 MiB") });
    await expect(observe()).rejects.toThrow("4 MiB");
  });
  it("does not turn a behavioral repair into a literal-word acceptance check", () => {
    const text = "Repair sample.txt and preserve its interface.";
    const response = { disposition: "continue", requirements: [{ kind: "change", description: text, quote: text, checks: [{ description: "Repair behavior", kind: "inspection", operation: "verbatim_source", path: "sample.txt" }] }], updates: [], full_suite: false };
    expect(() => parseTaskInterpretation(JSON.stringify(response), "00000000-0000-4000-8000-000000000001", text)).toThrow("direct request for exact file content");
  });
  it.each([
    ["semantic","execution",null,true], ["semantic","inspection","sample.txt",false],
    ["verbatim_source","inspection","sample.txt",true], ["verbatim_source","delivery","sample.txt",true],
    ["verbatim_source","execution","sample.txt",false], ["verbatim_source","inspection",null,false],
  ])("agrees at the model and host boundaries for %s/%s with path %s", (operation,kind,path,valid) => {
    const text = "Read sample.txt and report its exact content.";
    const response = {disposition:"continue",requirements:[{kind:"inspect",description:text,quote:text,checks:[{description:text,kind,operation,path}]}],updates:[],full_suite:false};
    expect(new Validator().validate(response,agentInterpretationResponseSchema.schema).valid).toBe(valid);
    const parse = () => parseTaskInterpretation(JSON.stringify(response),"00000000-0000-4000-8000-000000000001",text);
    if(valid)expect(parse).not.toThrow(); else expect(parse).toThrow();
  });
});
