import { approvedPythonTool as executePythonTool } from "./helpers/approved-python.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentLoop } from "./helpers/agent-loop-fixture.js";
import { generateDeliverableTool } from "../src/main/tools/specialist-tools.js";
import { createRunDirectories, resolveRunPath } from "../src/main/run/filesystem.js";
import { extractAlignedSvgLabels, extractAttributedDocumentNotes, extractDocxText } from "../src/main/tools/document-reader.js";
import { normalizeRunContract } from "../src/main/run/contract.js";
import { validateAndNormalizeIntent } from "../src/main/router/contextual-router.js";
import { buildExecutionEnvelope } from "../src/main/run/envelope.js";

describe("Local model flow regressions", () => {
  let root: string, previous: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "local-flow-"));
    previous = process.env.WORKBENCH_DATA_ROOT;
    process.env.WORKBENCH_DATA_ROOT = root;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.WORKBENCH_DATA_ROOT;
    else process.env.WORKBENCH_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves the exact argv interface when source and data are attached", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    writeFileSync(resolveRunPath(runId, "input/original.py", "input"), "raise ValueError('original failure')\n");
    writeFileSync(resolveRunPath(runId, "input/sample.csv", "input"), "value\n7\n");
    const code = "import sys, csv\nassert len(sys.argv) == 2, sys.argv\nwith open(sys.argv[1]) as f:\n    print(sum(int(row['value']) for row in csv.DictReader(f)))\n";
    const result = await executePythonTool.execute({ filename: "corrected.py", code, input_files: ["sample.csv"] }, { runId, workspaceRoot: root, gateway: {} as any });
    expect(result.ok).not.toBe(false);
    expect(JSON.parse(result.output).stdout.trim()).toBe("7");
    const artifact = result.artifacts!.find(a => a.filename.endsWith(".py"))!;
    expect(readFileSync(path.join(root, artifact.relativePath), "utf8")).toBe(code);
  });

  it("renders escaped document line breaks as real table rows", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    const content = "# Review\\n\\n| Source | Observed | Limit |\\n| --- | --- | --- |\\n| vessel-report, page 2 | 7.2 mm | 8.0 mm |";
    const result = await generateDeliverableTool.execute({ type: "docx", filename: "review.docx", content }, { runId, workspaceRoot: root, gateway: {} as any });
    const extracted = await extractDocxText(path.join(root, result.artifacts![0].relativePath));
    expect(extracted.text).toContain("| Source | Observed | Limit |");
    expect(extracted.text).toContain("vessel-report, page 2");
    expect(extracted.text).not.toContain("\\n");
  });

  it("rejects an unknown artifact type before writing files", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    await expect(generateDeliverableTool.execute({ type: "approval_note", filename: "review.md", content: "Actual review content." }, { runId, workspaceRoot: root, gateway: {} as any }))
      .rejects.toMatchObject({ code: "invalid_arguments", retryable: true });
  });

  it("keeps signed document annotations as source text with their real page", () => {
    expect(extractAttributedDocumentNotes("--- Page 1 ---\nVERIFY SEAL FACE\n— inspecting reviewer\n--- Page 3 ---\nCheck support alignment\n- site auditor\n"))
      .toEqual([{ page: 1, text: "VERIFY SEAL FACE" }, { page: 3, text: "Check support alignment" }]);
  });

  it("keeps SVG tags with aligned source labels without adding observed values", () => {
    const svg = Buffer.from('<svg><text x="420" y="20">VALVE-K9</text><text x="420" y="40">Class 600</text><text x="800" y="20">DN150 outlet</text></svg>');
    expect(extractAlignedSvgLabels(svg)).toEqual(["VALVE-K9 | Class 600"]);
  });

  it("retains slightly offset drawing labels in their source columns", () => {
    const svg = Buffer.from('<svg><text x="115" y="40" font-size="18">PUMP-R7</text><text x="508" y="40" font-size="18">VALVE-K9</text><text x="492" y="180" font-size="20">Class 600</text><text x="492" y="205" font-size="16">valve rating</text><text x="810" y="180" font-size="20">DN150</text><text x="803" y="205" font-size="16">outlet line</text></svg>');
    expect(extractAlignedSvgLabels(svg)).toEqual(["VALVE-K9 | Class 600 | valve rating", "DN150 | outlet line"]);
  });

  it("applies statement edits relative to source indentation without changing the input", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    const source = "import csv, sys\ndef summarize(filename):\n    total = 0\n    with open(filename) as f:\n        for row in csv.DictReader(f):\n            total += int(row['value'])\n    return total\nprint(summarize(sys.argv[1]))\n";
    const sourcePath = resolveRunPath(runId, "input/original.py", "input");
    writeFileSync(sourcePath, source);
    writeFileSync(resolveRunPath(runId, "input/sample.csv", "input"), "value\n7\n\ninvalid\n3\n");
    const result = await executePythonTool.execute({ source_file: "original.py", filename: "corrected.py", input_files: ["sample.csv"], edit_indentation:'relative',
      edits: [{ old: "total += int(row['value'])", new: "try:\n    total += int(row['value'])\nexcept ValueError:\n    continue" }] }, { runId, workspaceRoot: root, gateway: {} as any });
    expect(result.ok,result.output).not.toBe(false);
    expect(JSON.parse(result.output).stdout.trim()).toBe("10");
    expect(readFileSync(sourcePath, "utf8")).toBe(source);
    const artifact = result.artifacts!.find(a => a.filename.endsWith(".py"))!;
    expect(readFileSync(path.join(root, artifact.relativePath), "utf8")).toContain("            try:\n                total += int(row['value'])\n            except ValueError:");
  });

  it("requires all source pages and preserves inspector notes in a real Word table", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    const context = { runId, workspaceRoot: root, gateway: {} as any, sourceReferences: [{ filename: "inspection.pdf", page: 1 }, { filename: "inspection.pdf", page: 2 }] };
    const row = { source: "inspection.pdf, page 1", equipment: "vessel", measurements: "7.2 mm, minimum 8.0 mm", defects: "wall loss", inspector_notes: "CHECK VALVE SEAT", decision: "Repair before clearance", citations: "Procedure section 2" };
    await expect(generateDeliverableTool.execute({ type: "docx", report_rows: [row] }, context)).rejects.toMatchObject({ code: "invalid_arguments" });
    const result = await generateDeliverableTool.execute({ type: "docx", filename: "review.docx", report_rows: [row, { ...row, source: "inspection.pdf, page 2", defects: "seal wear" }] }, context);
    const text = (await extractDocxText(path.join(root, result.artifacts![0].relativePath))).text;
    expect(text).toContain("CHECK VALVE SEAT");
    expect(text).toContain("seal wear");
    expect((result.data as { responseText: string }).responseText).toContain("CHECK VALVE SEAT");
  });

  it("does not decode intentional backslashes in executable source twice", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    const code = String.raw`print("left\nright")`;
    const result = await executePythonTool.execute({ filename: "exact.py", code, input_files: [] }, { runId, workspaceRoot: root, gateway: {} as any });
    expect(result.ok).not.toBe(false);
    expect(JSON.parse(result.output).stdout).toBe("left\nright\n");
    expect(readFileSync(path.join(root, result.artifacts![0].relativePath), "utf8")).toBe(code);
  });

  it("uses semantic flags instead of prompt keywords for capability exposure", () => {
    const envelope = buildExecutionEnvelope({ runId: randomUUID(), modelId: "primary-model", mode: "chat", hasWorkspace: true,
      attachments: [], userPrompt: "Fix this and create a Word report", mutationRequested: false,
      commandExecutionRequested: false, deliverableRequested: false, computationRequested: false });
    expect(envelope.activeCapabilities).not.toContain("artifact_generation");
    expect(envelope.activeCapabilities).not.toContain("structured_computation");
    expect(envelope.activeCapabilities).not.toContain("workspace_mutation");
  });

  it("keeps tool rules and ends tool exposure after a verified export", async () => {
    const runId = randomUUID();
    createRunDirectories(runId);
    const intent = validateAndNormalizeIntent({ intentType: "document_drafting", primaryGoal: "Write review", isActionable: true,
      chatResponseOnly: false, workspaceMutationRequested: false, expectedDeliverables: [{ type: "md", filename: "review.md" }] },
    { hasWorkspace: false, workspaceFiles: [], userPrompt: "Please put the results in a note." });
    const contract = normalizeRunContract(runId, intent);
    let calls = 0;
    const gateway = {
      registry: new Map([["primary-model", { maxOutputTokens: 1536 }]]),
      async chatWithTools(_id: string, messages: any[], tools: any[], options: any) {
        calls++;
        expect(messages[0].content).toContain("Dependent calls belong in later turns.");
        if (calls === 1) return { ok: true, value: { content: null, tool_calls: [{ id: "export", name: "generate_deliverable", arguments: { type: "md", filename: "review.md", content: "# Review\n\nObserved result: 7.2 mm is below the specified 8.0 mm minimum." } }] } };
        expect(tools).toEqual([]);
        expect(options.maxTokens).toBe(512);
        return { ok: true, value: { content: "The review is saved in review.md. The observed 7.2 mm is below the 8.0 mm minimum.", tool_calls: null } };
      },
    };
    const result = await new AgentLoop().run({ runId, driverModelId: "primary-model", userPrompt: "Please put the results in a note.",
      systemPrompt: "Use the supplied measured result.", runContract: contract, tools: [{ ...generateDeliverableTool, async execute(args, context) {
        const result = await generateDeliverableTool.execute(args, context);
        return { ...result, data: undefined }; // Older tools without a reusable narrative still need a final turn.
      } }],
      context: { runId, workspaceRoot: root, gateway: gateway as any }, emitEvent: () => {}, onPlanConfirmationRequired: async () => true });
    expect(result.outcome).toBe("completed");
    expect(calls).toBe(2);
    expect(result.finalText.match(/observed/gi)).toHaveLength(1);
  });
});
