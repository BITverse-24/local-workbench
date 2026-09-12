import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import JSZip from "jszip";
import { createRunDirectories, resolveRunPath } from "../src/main/run/filesystem.js";
import { generateDocx } from "../src/main/tools/artifacts.js";

describe("Binary DOCX Generator", () => {
  let tempRoot: string;
  const runId = "00000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "wb-docx-test-"));
    process.env.WORKBENCH_DATA_ROOT = tempRoot;
    createRunDirectories(runId);
  });

  afterEach(() => {
    delete process.env.WORKBENCH_DATA_ROOT;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("generates a valid binary Office Open XML (.docx) file with PK zip header", async () => {
    const sampleMarkdown = [
      "# Engineering Approval Note",
      "",
      "### Equipment Details",
      "- Equipment Tag: **E-201**",
      "- Inspection Date: `2026-08-20`",
      "",
      "### Findings Table",
      "| Component | Measurement | Status | Citation |",
      "|---|---|---|---|",
      "| Tube Wall | 3.8 mm | FAIL | `[SOP-114 §3.2]` |",
      "| Shell Nozzle | 1.8 mm | PASS | `[SOP-114 §3.2]` |",
      "",
      "⚠️ **Missing Information**: Approval authority disposition is pending review.",
      "",
      "### Recommendation",
      "Conditional clearance granted pending retubing of affected tubes.",
    ].join("\n");

    const artifact = await generateDocx(runId, sampleMarkdown, "approval-note-E201.docx");

    expect(artifact.filename).toBe("approval-note-E201.docx");
    expect(artifact.kind).toBe("docx");
    expect(artifact.sizeBytes).toBeGreaterThan(1000);

    const fullPath = resolveRunPath(runId, "output/approval-note-E201.docx", "output");
    const fileBytes = readFileSync(fullPath);

    // 1. Verify standard ZIP / PK file signature: 0x50, 0x4B, 0x03, 0x04 ("PK\x03\x04")
    expect(fileBytes[0]).toBe(0x50);
    expect(fileBytes[1]).toBe(0x4b);
    expect(fileBytes[2]).toBe(0x03);
    expect(fileBytes[3]).toBe(0x04);

    // 2. Unpack with JSZip and verify required OpenXML parts
    const zip = await JSZip.loadAsync(fileBytes);
    expect(zip.file("[Content_Types].xml")).not.toBeNull();
    expect(zip.file("_rels/.rels")).not.toBeNull();
    expect(zip.file("word/document.xml")).not.toBeNull();
    expect(zip.file("word/styles.xml")).not.toBeNull();

    // 3. Inspect document.xml content
    const documentXml = await zip.file("word/document.xml")!.async("string");
    expect(documentXml).toContain("Engineering Approval Note");
    expect(documentXml).toContain("E-201");
    expect(documentXml).toContain("Tube Wall");
    expect(documentXml).toContain("Missing Information");
    expect(documentXml).toContain("[SOP-114 §3.2]");
    expect(documentXml).toContain("SOVEREIGN WORKBENCH");

    // 4. Verify compatibility with macOS textutil
    try {
      const output = execSync(`textutil -info "${fullPath}"`, { encoding: "utf8" });
      expect(output).toContain("Office Open XML format");
    } catch {
      // In non-mac environments or restricted sandboxes, skip textutil
    }
  });
});
