import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelGateway } from "../src/main/gateway/model-gateway.js";
import { RunManager } from "../src/main/run/manager.js";
import * as pythonModule from "../src/main/tools/python.js";
import { vi } from "vitest";
import { createChat } from "../src/main/persistence/chats.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";
import type { ModelRequest, ModelResponse, RunEvent } from "../src/shared/contracts.js";

let tempDir = "";
vi.mock("../src/main/tools/python.js", () => ({ executePython: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "ROWS 2\nOUT_OF_RANGE 7/240 (high=5, low=2)", stderr: "", timedOut: false, durationMs: 100, outputFiles: ["summary.csv", "csv-summary.xlsx"] }) }));

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
  return new Promise((resolve, reject) => {
    const poll = () => {
      const errEvent = events.find((candidate) => candidate.type === "error");
      if (errEvent && state !== "failed") {
        reject(new Error(`Run failed with error event: ${(errEvent as { message?: string }).message}`));
        return;
      }
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
            outputFiles: [],
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
    const completed = await waitForState(events, "completed");
    expect(events.some((event) => event.type === "routing" && event.taskType === "code")).toBe(true);

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
            filename: "task.py", source, expectedResult: "row count", inputFiles: ["input.csv"], allowedImports: ["csv"],
            outputFiles: ["summary.csv"], outputMode: "artifact", artifactKind: "xlsx", artifactFilename: "csv-summary.xlsx", artifactRationale: "Requested Excel export",
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

  it("copies the prior attachment into a follow-up run workspace", async () => {
    const events: RunEvent[] = [];
    const source = [
      "import csv",
      "import math",
      "with open('input.csv', newline='') as source_file:",
      "    values = [float(row['value']) for row in csv.DictReader(source_file)]",
      "mean = sum(values) / len(values)",
      "print(f'STDDEV {math.sqrt(sum((value - mean) ** 2 for value in values) / len(values)):.4f}')",
    ].join("\n");
    let codeCalls = 0;
    const gateway = {
      async complete(request: ModelRequest) {
        if (request.responseFormat === "code-result") {
          codeCalls += 1;
          return response(request, {
            filename: "task.py", source, expectedResult: "standard deviation", inputFiles: ["input.csv"], outputFiles: [], allowedImports: ["csv", "math"], outputMode: "chat",
          });
        }
        return response(request, { summary: "STDDEV 5.0000", verified: true });
      },
      async health() { return []; },
    } as unknown as ModelGateway;
    const manager = new RunManager(gateway, (event) => events.push(event));
    const chatId = createChat("CSV follow-up");
    const csv = "value\n0\n10\n";
    const registered = manager.registerAttachment({ chatId, filename: "input.csv", mediaType: "text/csv", sizeBytes: Buffer.byteLength(csv), base64OrBuffer: Buffer.from(csv) });
    const first = await manager.start({ userText: "Summarise this CSV", attachmentToken: registered.attachment.attachmentId, runId: registered.runId, chatId });

    await waitForState(events, "completed");

    const second = await manager.start({ userText: "What is the standard deviation?", chatId });

    await waitForState(events, "completed");
    expect(events.some((event) => event.type === "assistant_message" && event.text === "STDDEV 5.0000")).toBe(true);
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("generates and registers a txt artifact when requested without prompting for xlsx", async () => {
    vi.mocked(pythonModule.executePython).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Summary saved to summary.txt",
      stderr: "",
      timedOut: false,
      durationMs: 40,
      outputFiles: ["summary.txt"],
    });
    const events: RunEvent[] = [];
    const source = [
      "with open('summary.txt', 'w') as f:",
      "    f.write('Reactor Summary Report')",
      "print('Summary saved to summary.txt')",
    ].join("\n");
    const gateway = {
      async complete(request: ModelRequest) {
        if (request.responseFormat === "code-result") {
          return response(request, {
            filename: "task.py",
            source,
            expectedResult: "summary.txt contains detailed summary",
            inputFiles: ["input.csv"],
            outputFiles: ["summary.txt"],
            allowedImports: ["csv"],
            outputMode: "artifact",
            artifactKind: "txt",
            artifactFilename: "summary.txt",
            artifactRationale: "User explicitly requested summary.txt",
          });
        }
        return response(request, { summary: "Summary written to summary.txt", verified: true });
      },
      async health() { return []; },
    } as unknown as ModelGateway;
    const manager = new RunManager(gateway, (event) => events.push(event));
    const csv = "name,value\na,10\nb,20\n";
    const registered = manager.registerAttachment({ filename: "input.csv", mediaType: "text/csv", sizeBytes: Buffer.byteLength(csv), base64OrBuffer: Buffer.from(csv) });
    const started = await manager.start({
      userText: "Write a detailed summary in summary.txt (make a file)",
      attachmentToken: registered.attachment.attachmentId,
      runId: registered.runId,
    });

    const executeConfirmation = await waitForEvent(events, "confirmation_required") as Extract<RunEvent, { type: "confirmation_required" }>;
    expect(executeConfirmation.action.kind).toBe("execute_python");
    await manager.confirm({ runId: started.runId, actionId: executeConfirmation.action.actionId, approved: true });

    await waitForState(events, "completed");

    // Must NOT have prompted for XLSX generation
    const confirmations = events.filter((e) => e.type === "confirmation_required");
    expect(confirmations.every((c) => (c as Extract<RunEvent, { type: "confirmation_required" }>).action.kind !== "generate_xlsx")).toBe(true);

    // Must have emitted artifact_ready for summary.txt
    const artifactEvent = events.find((e): e is Extract<RunEvent, { type: "artifact_ready" }> => e.type === "artifact_ready");
    expect(artifactEvent).toBeDefined();
    expect(artifactEvent?.artifact.filename).toBe("summary.txt");
    expect(artifactEvent?.artifact.kind).toBe("txt");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("generates and registers a csv artifact when requested without prompting for xlsx", async () => {
    vi.mocked(pythonModule.executePython).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Out of range rows saved",
      stderr: "",
      timedOut: false,
      durationMs: 40,
      outputFiles: ["out-of-range.csv"],
    });
    const events: RunEvent[] = [];
    const source = [
      "with open('out-of-range.csv', 'w') as f:",
      "    f.write('id,temp\\n1,105\\n')",
      "print('Out of range rows saved')",
    ].join("\n");
    const gateway = {
      async complete(request: ModelRequest) {
        if (request.responseFormat === "code-result") {
          return response(request, {
            filename: "task.py",
            source,
            expectedResult: "out-of-range.csv contains flagged rows",
            inputFiles: ["input.csv"],
            outputFiles: ["out-of-range.csv"],
            allowedImports: ["csv"],
            outputMode: "artifact",
            artifactKind: "csv",
            artifactFilename: "out-of-range.csv",
            artifactRationale: "User explicitly requested out-of-range.csv",
          });
        }
        return response(request, { summary: "Flagged rows saved to out-of-range.csv", verified: true });
      },
      async health() { return []; },
    } as unknown as ModelGateway;
    const manager = new RunManager(gateway, (event) => events.push(event));
    const csv = "name,value\na,10\nb,20\n";
    const registered = manager.registerAttachment({ filename: "input.csv", mediaType: "text/csv", sizeBytes: Buffer.byteLength(csv), base64OrBuffer: Buffer.from(csv) });
    const started = await manager.start({
      userText: "Export out-of-range rows to out-of-range.csv",
      attachmentToken: registered.attachment.attachmentId,
      runId: registered.runId,
    });

    const executeConfirmation = await waitForEvent(events, "confirmation_required") as Extract<RunEvent, { type: "confirmation_required" }>;
    expect(executeConfirmation.action.kind).toBe("execute_python");
    await manager.confirm({ runId: started.runId, actionId: executeConfirmation.action.actionId, approved: true });

    await waitForState(events, "completed");

    // Must NOT have prompted for XLSX generation
    const confirmations = events.filter((e) => e.type === "confirmation_required");
    expect(confirmations.every((c) => (c as Extract<RunEvent, { type: "confirmation_required" }>).action.kind !== "generate_xlsx")).toBe(true);

    // Must have emitted artifact_ready for out-of-range.csv
    const artifactEvent = events.find((e): e is Extract<RunEvent, { type: "artifact_ready" }> => e.type === "artifact_ready");
    expect(artifactEvent).toBeDefined();
    expect(artifactEvent?.artifact.filename).toBe("out-of-range.csv");
    expect(artifactEvent?.artifact.kind).toBe("csv");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("generates and registers a markdown artifact when requested without prompting for xlsx", async () => {
    vi.mocked(pythonModule.executePython).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "Markdown report generated",
      stderr: "",
      timedOut: false,
      durationMs: 40,
      outputFiles: ["report.md"],
    });
    const events: RunEvent[] = [];
    const source = [
      "with open('report.md', 'w') as f:",
      "    f.write('# Report\\n\\nAll good.')",
      "print('Markdown report generated')",
    ].join("\n");
    const gateway = {
      async complete(request: ModelRequest) {
        if (request.responseFormat === "code-result") {
          return response(request, {
            filename: "task.py",
            source,
            expectedResult: "report.md contains formatted summary",
            inputFiles: ["input.csv"],
            outputFiles: ["report.md"],
            allowedImports: ["csv"],
            outputMode: "artifact",
            artifactKind: "md",
            artifactFilename: "report.md",
            artifactRationale: "User explicitly requested report.md",
          });
        }
        return response(request, { summary: "Report written to report.md", verified: true });
      },
      async health() { return []; },
    } as unknown as ModelGateway;
    const manager = new RunManager(gateway, (event) => events.push(event));
    const csv = "name,value\na,10\nb,20\n";
    const registered = manager.registerAttachment({ filename: "input.csv", mediaType: "text/csv", sizeBytes: Buffer.byteLength(csv), base64OrBuffer: Buffer.from(csv) });
    const started = await manager.start({
      userText: "Write a detailed report in report.md (export file)",
      attachmentToken: registered.attachment.attachmentId,
      runId: registered.runId,
    });

    const executeConfirmation = await waitForEvent(events, "confirmation_required") as Extract<RunEvent, { type: "confirmation_required" }>;
    expect(executeConfirmation.action.kind).toBe("execute_python");
    await manager.confirm({ runId: started.runId, actionId: executeConfirmation.action.actionId, approved: true });

    await waitForState(events, "completed");

    // Must NOT have prompted for XLSX generation
    const confirmations = events.filter((e) => e.type === "confirmation_required");
    expect(confirmations.every((c) => (c as Extract<RunEvent, { type: "confirmation_required" }>).action.kind !== "generate_xlsx")).toBe(true);

    // Must have emitted artifact_ready for report.md
    const artifactEvent = events.find((e): e is Extract<RunEvent, { type: "artifact_ready" }> => e.type === "artifact_ready");
    expect(artifactEvent).toBeDefined();
    expect(artifactEvent?.artifact.filename).toBe("report.md");
    expect(artifactEvent?.artifact.kind).toBe("md");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("recovers and completes when initial Python execution fails with an error", async () => {
    // 1st attempt fails with TypeError, 2nd attempt succeeds
    vi.mocked(pythonModule.executePython)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "TypeError: '>' not supported between instances of 'str' and 'NoneType'",
        timedOut: false,
        durationMs: 30,
        outputFiles: [],
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Data Summary: Total readings: 240, Avg: 25.4 °C",
        stderr: "",
        timedOut: false,
        durationMs: 40,
        outputFiles: [],
      });

    const events: RunEvent[] = [];
    let codeCalls = 0;
    const gateway = {
      async complete(request: ModelRequest) {
        if (request.responseFormat === "code-result") {
          codeCalls++;
          if (codeCalls === 1) {
            // First code attempt with bug
            return response(request, {
              filename: "task.py",
              source: "ts = '2024-01-01'\nlast = None\nif ts > last: pass",
              expectedResult: "Summary",
              inputFiles: ["input.csv"],
              outputFiles: [],
              allowedImports: ["csv"],
              outputMode: "chat",
            });
          }
          // Repaired code
          expect(request.userPrompt).toContain("PREVIOUS SCRIPT ATTEMPT FAILED");
          expect(request.userPrompt).toContain("TypeError");
          return response(request, {
            filename: "task.py",
            source: "ts = '2024-01-01'\nlast = None\nif last is None or ts > last: last = ts\nprint('Data Summary: Total readings: 240, Avg: 25.4 °C')",
            expectedResult: "Summary",
            inputFiles: ["input.csv"],
            outputFiles: [],
            allowedImports: ["csv"],
            outputMode: "chat",
          });
        }
        return response(request, { summary: "Data Summary: Total readings: 240, Avg: 25.4 °C", verified: true });
      },
      async health() { return []; },
    } as unknown as ModelGateway;

    const manager = new RunManager(gateway, (event) => events.push(event));
    const csv = "timestamp,temperature_c\n2024-01-01,25.4\n";
    const registered = manager.registerAttachment({ filename: "input.csv", mediaType: "text/csv", sizeBytes: Buffer.byteLength(csv), base64OrBuffer: Buffer.from(csv) });
    await manager.start({
      userText: "Summarise this CSV",
      attachmentToken: registered.attachment.attachmentId,
      runId: registered.runId,
    });

    await waitForState(events, "completed");

    expect(codeCalls).toBe(2);
    expect(events.some((e) => e.type === "tool_call" && e.summary.includes("repairing Python script"))).toBe(true);
    expect(events.some((e) => e.type === "assistant_message" && e.text.includes("Total readings: 240"))).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("handles and sanitizes multiline with statements during script self-repair", async () => {
    vi.mocked(pythonModule.executePython)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "ValueError: could not convert string to float: ''",
        timedOut: false,
        durationMs: 35,
        outputFiles: [],
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "Processed log summary: {'ok': 3, 'malformed': 1, 'high': 2}",
        stderr: "",
        timedOut: false,
        durationMs: 40,
        outputFiles: ["repaired-vendor-log.csv"],
      });

    const events: RunEvent[] = [];
    const brokenScript = `import csv\nimport sys\n\ndef summarize(path):\n    with open(path) as f:\n        for row in csv.DictReader(f):\n            val = float(row['temperature_c'])\nif __name__ == '__main__':\n    summarize(sys.argv[1])\n`;
    const multilineWithRepaired = `import csv\n\ndef process_vendor_log(input_path: str, output_path: str):\n    counts = {'ok': 0, 'malformed': 0, 'high': 0}\n    with open(input_path, newline="", encoding="utf-8") as infile,\n         open(output_path, 'w', newline="", encoding="utf-8") as outfile:\n        reader = csv.DictReader(infile)\n        writer = csv.DictWriter(outfile, fieldnames=reader.fieldnames + ['status'])\n        writer.writeheader()\n        for row in reader:\n            try:\n                t = float(row['temperature_c'])\n                if t >= 350.0:\n                    counts['high'] += 1\n                    row['status'] = 'high'\n                else:\n                    row['status'] = 'ok'\n                counts['ok'] += 1\n            except (ValueError, TypeError):\n                counts['malformed'] += 1\n                row['status'] = 'malformed'\n            writer.writerow(row)\n    return counts\n\nif __name__ == '__main__':\n    print(f"Processed log summary: {process_vendor_log('vendor-maintenance-log.csv', 'repaired-vendor-log.csv')}")\n`;

    const gateway = {
      async complete(request: ModelRequest) {
        if (request.responseFormat === "code-result") {
          return response(request, {
            filename: "task.py",
            source: multilineWithRepaired,
            expectedResult: "Processed vendor log with evaluated status",
            inputFiles: ["vendor-maintenance-log.csv"],
            outputFiles: ["repaired-vendor-log.csv"],
            allowedImports: ["csv"],
            outputMode: "chat_and_artifact",
            artifactKind: "csv",
            artifactFilename: "repaired-vendor-log.csv",
            artifactRationale: "Repaired log file with status column",
          });
        }
        return response(request, { summary: "Resolved ValueError and inclusive limit boundary.", verified: true });
      },
      async health() { return []; },
    } as unknown as ModelGateway;

    const manager = new RunManager(gateway, (event) => events.push(event));
    const csv = "timestamp,temperature_c\n2026-08-21T09:00,349.8\n2026-08-21T09:10,\n";
    const regPy = manager.registerAttachment({ filename: "broken-vendor-log-parser.py", mediaType: "text/x-python", sizeBytes: Buffer.byteLength(brokenScript), base64OrBuffer: Buffer.from(brokenScript) });
    const regCsv = manager.registerAttachment({ filename: "vendor-maintenance-log.csv", mediaType: "text/csv", sizeBytes: Buffer.byteLength(csv), base64OrBuffer: Buffer.from(csv) });

    const started = await manager.start({
      userText: "This is crashing on our vendor log files. Fix it and make sure it actually works.",
      attachmentTokens: [regPy.attachment.attachmentId, regCsv.attachment.attachmentId],
    });

    const confirmEvt = await waitForEvent(events, "confirmation_required") as Extract<RunEvent, { type: "confirmation_required" }>;
    expect(confirmEvt.action.kind).toBe("execute_python");
    await manager.confirm({ runId: started.runId, actionId: confirmEvt.action.actionId, approved: true });

    await waitForState(events, "completed");

    const artifacts = events.filter((e) => e.type === "artifact_ready").map((e: any) => e.artifact.filename);
    expect(artifacts).toContain("repaired-broken-vendor-log-parser.py");
    expect(artifacts).toContain("repaired-vendor-log.csv");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});


