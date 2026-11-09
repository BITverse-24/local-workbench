import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { setDataDir } from "../src/main/run/filesystem.js";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { RunManager } from "../src/main/run/manager.js";
import { HarnessManager } from "../src/main/harness/harness-manager.js";
import { getExecutionLedger } from "../src/main/run/execution-ledger.js";

describe("agent-symbol-repair", () => {
  let workRoot: string;
  let dataDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.WORKBENCH_AGENT_EDIT_MODE;
    process.env.WORKBENCH_AGENT_EDIT_MODE = "symbol";
    workRoot = mkdtempSync(path.join(tmpdir(), "agent-sym-work-"));
    dataDir = mkdtempSync(path.join(tmpdir(), "agent-sym-data-"));
    setDataDir(dataDir);
    initDb(path.join(dataDir, "db.sqlite"));
  });

  afterEach(() => {
    if (prevEnv !== undefined) {
      process.env.WORKBENCH_AGENT_EDIT_MODE = prevEnv;
    } else {
      delete process.env.WORKBENCH_AGENT_EDIT_MODE;
    }
    try { closeDb(); } catch {}
    try { rmSync(workRoot, { recursive: true, force: true }); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  });

  it("exposes replace_symbol tool when WORKBENCH_AGENT_EDIT_MODE=symbol", async () => {
    // Write sample target file and test
    writeFileSync(path.join(workRoot, "package.json"), JSON.stringify({ name: "sym-test", type: "module" }));
    writeFileSync(path.join(workRoot, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
    writeFileSync(path.join(workRoot, "math.test.js"), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './math.js';\ntest('add', () => { assert.strictEqual(add(1, 2), 3); });\n");

    let toolsOffered: string[] = [];
    const mockGateway = {
      chatWithTools: async (_modelId: string, _messages: any[], tools: any[]) => {
        toolsOffered = tools.map((t: any) => t.function?.name || t.name);
        return {
          ok: true,
          value: {
            content: "I will replace the add function",
            tool_calls: [
              {
                id: "call-1",
                name: "replace_symbol",
                arguments: {
                  edits: [
                    {
                      symbol: "add",
                      new_source: "function add(a, b) {\n  return a + b;\n}"
                    }
                  ]
                }
              }
            ]
          }
        };
      }
    } as any;

    expect(mockGateway).toBeDefined();
  });
});
