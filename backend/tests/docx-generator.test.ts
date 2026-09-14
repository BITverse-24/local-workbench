import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createDocxBuffer, generateDocx } from "../src/main/tools/artifacts.js";
import { absoluteDataPath, runRoot } from "../src/main/run/filesystem.js";
import { initDb, closeDb } from "../src/main/persistence/db.js";
import { createRun } from "../src/main/run/store.js";
import { createChat } from "../src/main/persistence/chats.js";

describe("Formatted Binary DOCX Generator", () => {
  beforeEach(() => {
    initDb(":memory:");
    return () => {
      closeDb();
    };
  });

  it("generates a valid binary docx buffer with PK zip header", async () => {
    const input = {
      title: "Heat Exchanger E-201 Approval Note",
      body: "Equipment E-201 inspection passed with minor observations.",
      sections: [
        {
          heading: "Equipment Header",
          body: "E-201 Heat Exchanger",
        },
        {
          heading: "Findings",
          body: "Rows 12-15 measured 3.8mm against min allowable 4.6mm.",
        },
      ],
      metadata: {
        "Equipment ID": "E-201",
        "Assessor": "John Doe",
      },
      findings: [
        {
          item: "Tube Bundle Rows 12-15",
          measurement: "3.8 - 4.2 mm",
          condition: "Localized thinning",
          status: "Action Required",
        },
      ],
      citations: [
        {
          label: "SOP-114 §3.2",
          supportingExcerpt: "Tubes below allowable threshold must be scheduled for retubing.",
        },
      ],
    };

    const buffer = await createDocxBuffer(input);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);

    // PK zip magic header check (50 4B 03 04)
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
    expect(buffer[2]).toBe(0x03);
    expect(buffer[3]).toBe(0x04);
  });

  it("parses text/markdown into structured docx sections", async () => {
    const textInput = `# Approval Note — Heat Exchanger E-201

Equipment
E-201; report reference: IR-E201-2026-08-20

Findings
Rows 12–15 measured 3.8–4.2 mm against the minimum allowable 4.6 mm.

Recommendation
Conditional clearance pending retubing. [SOP-114 §3.2]`;

    const buffer = await createDocxBuffer(textInput);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer[0]).toBe(0x50);
    expect(buffer[1]).toBe(0x4b);
  });

  it("writes formatted binary docx artifact to run output directory", async () => {
    const chatId = createChat("Docx test");
    const runId = createRun(chatId, "Generate approval note");

    const artifact = await generateDocx(
      runId,
      {
        title: "Approval Note — Heat Exchanger E-201",
        body: "Conditional clearance granted.",
      },
      "approval-note-E201.docx",
    );

    expect(artifact.kind).toBe("docx");
    expect(artifact.filename).toBe("approval-note-E201.docx");

    const fullPath = absoluteDataPath(artifact.relativePath);
    expect(existsSync(fullPath)).toBe(true);

    const writtenBuffer = readFileSync(fullPath);
    expect(writtenBuffer[0]).toBe(0x50);
    expect(writtenBuffer[1]).toBe(0x4b);

    // Cleanup test run directory
    try {
      rmSync(runRoot(runId), { recursive: true, force: true });
    } catch {}
  });
});
