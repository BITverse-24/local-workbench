import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { RunManager } from "../src/main/run/manager.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import type { ModelRequest, ModelResponse, RunEvent } from "../src/shared/contracts.js";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-flow-b-e2e-"));
  process.env.WORKBENCH_DATA_ROOT = path.join(tempDir, "data");
  initDb(path.join(tempDir, "workbench.sqlite"));
});

afterEach(() => {
  closeDb();
  delete process.env.WORKBENCH_DATA_ROOT;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function response(request: ModelRequest, result: unknown): { ok: true; value: ModelResponse } {
  return {
    ok: true,
    value: {
      requestId: request.requestId,
      runId: request.runId,
      modelId: request.modelId,
      taskType: request.taskType,
      completedAt: new Date().toISOString(),
      result,
    } as ModelResponse,
  };
}

function waitForEvent(events: RunEvent[], type: RunEvent["type"]): Promise<RunEvent> {
  return new Promise((resolve) => {
    const poll = () => {
      const event = events.find((candidate) => candidate.type === type && !(candidate as { consumed?: boolean }).consumed);
      if (event) {
        (event as { consumed?: boolean }).consumed = true;
        resolve(event);
      } else setTimeout(poll, 5);
    };
    poll();
  });
}

function waitForState(events: RunEvent[], state: Extract<RunEvent, { type: "run_state" }>["state"]): Promise<Extract<RunEvent, { type: "run_state" }>> {
  return new Promise((resolve) => {
    const poll = () => {
      const event = events.find((candidate): candidate is Extract<RunEvent, { type: "run_state" }> => candidate.type === "run_state" && candidate.state === state);
      if (event) resolve(event);
      else setTimeout(poll, 5);
    };
    poll();
  });
}

describe("Flow B end-to-end", () => {
  it("routes, executes after approval, and summarizes in chat by default", async () => {
    const events: RunEvent[] = [];
    const source = [
      "import csv",
      "with open('input.csv', newline='') as source_file:",
      "    rows = list(csv.DictReader(source_file))",
      "with open('summary.csv', 'w', newline='') as output_file:",
      "    output_file.write('rows\\n' + str(len(rows)) + '\\n')",
      "print(f'ROWS {len(rows)}')",
    ].join("\n");
    let summaryCalls = 0;
    const gateway = {
      async complete(request: ModelRequest) {
        if (request.responseFormat === "code-result") {
          expect(request.userPrompt).toContain("name,value");
          return response(request, {
            filename: "task.py",
            source,
            expectedResult: "summary.csv contains the row count",
            inputFiles: ["input.csv"],
            outputFiles: ["summary.csv"],
            allowedImports: ["csv"],
          });
        }
        summaryCalls += 1;
        return response(request, { summary: "ROWS 2", verified: true });
      },
      async health() { return []; },
    } as unknown as ModelGateway;
    const manager = new RunManager(gateway, (event) => events.push(event));
    const csv = "name,value\na,10\nb,20\n";
    const registered = manager.registerAttachment({ filename: "input.csv", mediaType: "text/csv", sizeBytes: Buffer.byteLength(csv), base64OrBuffer: Buffer.from(csv) });
    const started = await manager.start({ userText: "Summarise this CSV", attachmentToken: registered.attachment.attachmentId, runId: registered.runId });
    const executeConfirmation = await waitForEvent(events, "confirmation_required") as Extract<RunEvent, { type: "confirmation_required" }>;
    expect(events.some((event) => event.type === "routing" && event.taskType === "code")).toBe(true);
    await manager.confirm({ runId: started.runId, actionId: executeConfirmation.action.actionId, approved: true });
    const completed = await waitForState(events, "completed");

    expect(completed.state).toBe("completed");
    expect(summaryCalls).toBe(1);
    expect(events.some((event) => event.type === "artifact_ready")).toBe(false);
    expect(events.some((event) => event.type === "tool_result" && event.summary.includes("exit code 0"))).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("requests an artifact only when the user asks for an Excel export", async () => {
    const events: RunEvent[] = [];
    const source = [
      "import csv",
      "with open('input.csv', newline='') as source_file:",
      "    rows = list(csv.DictReader(source_file))",
      "print(f'ROWS {len(rows)}')",
    ].join("\n");
    const gateway = {
      async complete(request: ModelRequest) {
        if (request.responseFormat === "code-result") {
          return response(request, {
            filename: "task.py", source, expectedResult: "row count", inputFiles: ["input.csv"], outputFiles: [], allowedImports: ["csv"],
            outputMode: "artifact", artifactKind: "xlsx", artifactFilename: "csv-summary.xlsx", artifactRationale: "Requested Excel export",
          });
        }
        return response(request, { summary: "ROWS 2", verified: true });
      },
      async health() { return []; },
    } as unknown as ModelGateway;
    const manager = new RunManager(gateway, (event) => events.push(event));
    const csv = "name,value\na,10\nb,20\n";
    const registered = manager.registerAttachment({ filename: "input.csv", mediaType: "text/csv", sizeBytes: Buffer.byteLength(csv), base64OrBuffer: Buffer.from(csv) });
    const started = await manager.start({ userText: "Summarise this CSV and create an Excel export", attachmentToken: registered.attachment.attachmentId, runId: registered.runId });
    const executeConfirmation = await waitForEvent(events, "confirmation_required") as Extract<RunEvent, { type: "confirmation_required" }>;
    await manager.confirm({ runId: started.runId, actionId: executeConfirmation.action.actionId, approved: true });
    const xlsxConfirmation = await waitForEvent(events, "confirmation_required") as Extract<RunEvent, { type: "confirmation_required" }>;
    expect(xlsxConfirmation.action.kind).toBe("generate_xlsx");
    await manager.confirm({ runId: started.runId, actionId: xlsxConfirmation.action.actionId, approved: true });
    await waitForState(events, "completed");
    expect(events.some((event) => event.type === "artifact_ready")).toBe(true);
    expect(events.some((event) => event.type === "assistant_message" && event.text === "ROWS 2")).toBe(true);
  });
});
