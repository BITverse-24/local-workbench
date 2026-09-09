import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunDirectories, registerAttachment, writeRunFile } from "../src/main/run/filesystem.js";
import { executePython } from "../src/main/tools/python.js";

let tempDir = "";

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  delete process.env.WORKBENCH_DATA_ROOT;
});

describe("Flow B Python execution", () => {
  it("executes a run-scoped CSV task and reports declared output files", async () => {
    tempDir = mkdtempSync(path.join(process.cwd(), ".tmp-python-test-"));
    process.env.WORKBENCH_DATA_ROOT = tempDir;
    const runId = "00000000-0000-4000-8000-000000000001";
    createRunDirectories(runId);
    const csv = "name,value\na,10\nb,20\n";
    const attachment = registerAttachment(runId, {
      filename: "input.csv",
      mediaType: "text/csv",
      sizeBytes: Buffer.byteLength(csv),
      base64OrBuffer: Buffer.from(csv),
    });
    const storedName = path.basename(attachment.relativePath);
    const source = [
      "import csv",
      "with open('input.csv', newline='') as source:",
      "    rows = list(csv.DictReader(source))",
      "with open('summary.csv', 'w', newline='') as output:",
      "    output.write('rows\\n' + str(len(rows)) + '\\n')",
      "print(f'ROWS {len(rows)}')",
    ].join("\n");
    writeRunFile(runId, "intermediate", "task.py", source);

    const result = await executePython(runId, source, ["input.csv"], [
      { logical: "input.csv", source: storedName },
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("ROWS 2");
    expect(result.outputFiles).toContain("summary.csv");
    expect(readFileSync(path.join(tempDir, "runs", runId, "output", "summary.csv"), "utf8")).toContain("2");
  });
});
