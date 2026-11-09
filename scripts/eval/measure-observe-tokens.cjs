const path = require("node:path");
const fs = require("node:fs");
const { buildSync } = require("esbuild");

const ROOT = path.resolve(__dirname, "../..");
const BUILD_DIR = path.join(ROOT, "tests/.runtime/build");
fs.mkdirSync(BUILD_DIR, { recursive: true });

const ENTRY_TS = path.join(ROOT, "tests/eval/measure-observe-tokens.ts");
const OUT_CJS = path.join(BUILD_DIR, "measure-observe-tokens.cjs");

// Write temporary TS runner for measurement
fs.writeFileSync(ENTRY_TS, `
import path from "node:path";
import fs from "node:fs";
import { getAllAvailableTools, filterToolsForTurn } from "../../backend/src/main/router/tool-compositor.js";
import { buildExecutionEnvelope } from "../../backend/src/main/run/envelope.js";
import { ToolDispatcher } from "../../backend/src/main/agent/tool-dispatcher.js";
import { conciseAgentTool, FINISH_TOOL } from "../../backend/src/main/agent/context-packet.js";
import { estimateToolTokens, countTokens } from "../../backend/src/main/agent/context-manager.js";
import type { CapabilityGroup } from "../../backend/src/shared/contracts.js";

async function measure() {
  const driverModelId = "qwen/qwen3.5-9b";
  const envelope = buildExecutionEnvelope({
    runId: "bench_exec_measure",
    mode: "agent",
    modelId: driverModelId,
    hasWorkspace: true,
    attachments: [],
    hasKnowledgeBaseDocs: true,
    hasRetrievableResults: true,
    userPrompt: "Analyze the codebase architecture and verify authentication flow.",
  });

  const allTools = getAllAvailableTools(driverModelId, true);
  const activeCaps = new Set<CapabilityGroup>(envelope.activeCapabilities);
  const visible = filterToolsForTurn(allTools, envelope, activeCaps, { hasRetrievableResults: true });

  const definitions = visible.map(tool => conciseAgentTool({
    ...tool.definition,
    function: {
      ...tool.definition.function,
      parameters: {
        ...tool.definition.function.parameters,
        properties: {
          ...tool.definition.function.parameters.properties,
          requirement_id: { type: "string" },
        },
      },
    },
  }));

  const allObserveDefs = [...definitions, FINISH_TOOL];
  const observeDefsTokens = estimateToolTokens(allObserveDefs);

  const sampleSignatures = \`declare const tools: {
  readFile(path: string, opts?: { startByte?: number }): Promise<{ content: string; complete: boolean; nextByte?: number; digest: string }>;
  search(query: string, opts?: { path?: string }): Promise<Array<{ path: string; line: number; text: string }>>;
  listDir(path: string): Promise<string[]>;
  readInput(id: string, page?: number): Promise<{ text: string; pages: number }>;
  extractDocument(filename: string, pages?: number[]): Promise<{ text: string }>;
  retrieveKnowledge(query: string): Promise<Array<{ file: string; page: number; text: string }>>;
  result(id: string, opts?: { offset?: number }): Promise<{ content: string; nextOffset?: number }>;
};
declare function text(value: unknown): void;
declare function escalate(reason: string): never;\`;

  const signaturesTokens = countTokens(sampleSignatures);

  const result = {
    date: new Date().toISOString(),
    toolCount: allObserveDefs.length,
    tools: allObserveDefs.map(d => d.function.name),
    observeDefinitionsTokens: observeDefsTokens,
    signaturesTokens,
    tokenSavingsPerObserveTurn: observeDefsTokens - signaturesTokens,
    percentageSavings: ((observeDefsTokens - signaturesTokens) / observeDefsTokens * 100).toFixed(1) + "%",
  };

  console.log(JSON.stringify(result, null, 2));

  const outPath = path.resolve(process.cwd(), "docs/eval/exec-baseline-2026-11-07.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log("Written baseline to", outPath);
}

measure().catch(err => {
  console.error("Measurement failed:", err);
  process.exit(1);
});
`, "utf8");

buildSync({
  entryPoints: [ENTRY_TS],
  outfile: OUT_CJS,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  packages: "external",
  logLevel: "error"
});

require(OUT_CJS);
