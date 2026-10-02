import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  verifyArtifactFile,
  generateDocx,
  generateXlsx,
  generateXlsxFromContent,
  isAuthorizedArtifactPath,
} from "../src/main/tools/artifacts.js";
import { generateDeliverableTool } from "../src/main/tools/specialist-tools.js";
import {
  createRunDirectories,
  resolveRunPath,
  runRoot,
} from "../src/main/run/filesystem.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";
import type { PythonExecutionResult } from "../src/shared/contracts.js";

describe("P0-04: Artifact Generation and Verification Lifecycle", () => {
  let runId: string;
  let testRunDir: string;

  beforeEach(() => {
    runId = randomUUID();
    testRunDir = createRunDirectories(runId);
  });

  afterEach(() => {
    try {
      if (existsSync(testRunDir)) {
        rmSync(testRunDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe("A. Shared Artifact Verification Function (verifyArtifactFile)", () => {
    it("fails when file does not exist", async () => {
      const nonExistentPath = resolveRunPath(runId, "output/missing.docx", "output");
      const result = await verifyArtifactFile(nonExistentPath, { runId, expectedKind: "docx" });

      expect(result.valid).toBe(false);
      expect(result.checks.exists).toBe(false);
      expect(result.details.error).toContain("does not exist");
    });

    it("fails when path escapes authorized directory", async () => {
      const externalPath = path.resolve(process.cwd(), "package.json");
      const result = await verifyArtifactFile(externalPath, { runId, expectedKind: "json" });

      expect(result.valid).toBe(false);
      expect(result.checks.exists).toBe(true);
      expect(result.checks.withinAuthorizedDir).toBe(false);
      expect(result.details.error).toContain("outside authorized run directory");
    });

    it("fails when file is 0 bytes unless allowEmpty is true", async () => {
      const emptyPath = resolveRunPath(runId, "output/empty.docx", "output");
      writeFileSync(emptyPath, Buffer.alloc(0));

      const result = await verifyArtifactFile(emptyPath, { runId, expectedKind: "docx" });
      expect(result.valid).toBe(false);
      expect(result.checks.nonEmpty).toBe(false);
      expect(result.details.error).toContain("is empty (0 bytes)");

      // With allowEmpty = true, fails at parser check instead
      const allowedResult = await verifyArtifactFile(emptyPath, { runId, expectedKind: "docx", allowEmpty: true });
      expect(allowedResult.checks.nonEmpty).toBe(true);
      expect(allowedResult.checks.parserOpened).toBe(false);
    });

    it("fails when file extension does not match expectedKind", async () => {
      const csvPath = resolveRunPath(runId, "output/data.csv", "output");
      writeFileSync(csvPath, "col1,col2\nval1,val2\n", "utf8");

      const result = await verifyArtifactFile(csvPath, { runId, expectedKind: "xlsx" });
      expect(result.valid).toBe(false);
      expect(result.checks.extensionMatches).toBe(false);
      expect(result.details.error).toContain('File extension ".csv" does not agree with requested artifact type "xlsx"');
    });

    it("fails when XLSX package is corrupt or unparseable", async () => {
      const corruptXlsx = resolveRunPath(runId, "output/corrupt.xlsx", "output");
      writeFileSync(corruptXlsx, Buffer.from("Not a valid PK zip xlsx file"));

      const result = await verifyArtifactFile(corruptXlsx, { runId, expectedKind: "xlsx" });
      expect(result.valid).toBe(false);
      expect(result.checks.parserOpened).toBe(false);
      expect(result.details.error).toContain("Failed to parse XLSX workbook");
    });

    it("fails when DOCX package is corrupt or unparseable", async () => {
      const corruptDocx = resolveRunPath(runId, "output/corrupt.docx", "output");
      writeFileSync(corruptDocx, Buffer.from("Not a valid PK zip docx file"));

      const result = await verifyArtifactFile(corruptDocx, { runId, expectedKind: "docx" });
      expect(result.valid).toBe(false);
      expect(result.checks.parserOpened).toBe(false);
      expect(result.details.error).toContain("Failed to open or parse DOCX package");
    });

    it("fails when XLSX contains only the fabricated 2-row completed placeholder", async () => {
      const placeholderPath = resolveRunPath(runId, "output/fabricated.xlsx", "output");
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Summary");
      ws.addRow(["Report", "Summary"]);
      ws.addRow(["Status", "Completed"]);
      await wb.xlsx.writeFile(placeholderPath);

      const result = await verifyArtifactFile(placeholderPath, { runId, expectedKind: "xlsx" });
      expect(result.valid).toBe(false);
      expect(result.checks.parserOpened).toBe(true);
      expect(result.checks.structuralValid).toBe(false);
      expect(result.details.error).toContain("Status: Completed");
    });

    it("fails when Markdown content does not match original submitted content", async () => {
      const mdPath = resolveRunPath(runId, "output/report.md", "output");
      writeFileSync(mdPath, "# Actual Content on Disk", "utf8");

      const result = await verifyArtifactFile(mdPath, {
        runId,
        expectedKind: "md",
        originalContent: "# Expected Different Content",
      });
      expect(result.valid).toBe(false);
      expect(result.checks.structuralValid).toBe(false);
      expect(result.details.contentMatch).toBe(false);
      expect(result.details.error).toContain("does not match submitted content");
    });

    it("passes for valid Markdown matching submitted content", async () => {
      const content = "# Technical Inspection Summary\nAll weld seams passed visual inspection.";
      const mdPath = resolveRunPath(runId, "output/valid.md", "output");
      writeFileSync(mdPath, content, "utf8");

      const result = await verifyArtifactFile(mdPath, {
        runId,
        expectedKind: "md",
        originalContent: content,
      });
      expect(result.valid).toBe(true);
      expect(result.checks.exists).toBe(true);
      expect(result.checks.withinAuthorizedDir).toBe(true);
      expect(result.checks.nonEmpty).toBe(true);
      expect(result.checks.extensionMatches).toBe(true);
      expect(result.checks.parserOpened).toBe(true);
      expect(result.checks.structuralValid).toBe(true);
      expect(result.details.contentMatch).toBe(true);
    });
  });

  describe("B. Elimination of Fabricated-Success Fallbacks in XLSX Generation", () => {
    it("rejects generateXlsxFromContent with non-tabular unstructured text", async () => {
      await expect(
        generateXlsxFromContent(runId, "Just a plain sentence with no delimiters or columns", "report.xlsx"),
      ).rejects.toThrow(/Failed to generate XLSX: Content contains no tabular rows/);
    });

    it("rejects generateXlsxFromContent when only generic placeholder tokens exist", async () => {
      await expect(
        generateXlsxFromContent(runId, "| Report | Summary |\n| Status | Completed |", "report.xlsx"),
      ).rejects.toThrow(/Failed to generate XLSX: Content contains no substantive tabular data rows/);
    });

    it("rejects generateXlsx when Python execution has no tabular or CSV output", async () => {
      const emptyExec: PythonExecutionResult = {
        exitCode: 0,
        stdout: "Script finished with no CSV or data output.",
        stderr: "",
        timedOut: false,
        outputFiles: [],
        durationMs: 45,
      };

      await expect(
        generateXlsx(runId, emptyExec, "summary.xlsx"),
      ).rejects.toThrow(/Failed to generate XLSX: Execution output contains no CSV or tabular rows/);
    });
  });

  describe("C. Staging -> Verification -> Promotion Lifecycle", () => {
    it("stages, verifies, and promotes a valid DOCX deliverable with verified: true", async () => {
      const docInput = {
        title: "Reactor Vessel Inspection Report",
        body: "Inspection of pressure boundary and nozzles revealed normal conditions. Ultrasonic thickness measurements were verified against baseline specs.",
        sections: [
          { heading: "Observations", body: "No cracking or localized pitting detected." },
        ],
      };

      const art = await generateDocx(runId, docInput, "reactor-note.docx");

      // 1. Staging file in intermediate/ must be deleted
      const intermediateDir = resolveRunPath(runId, "intermediate", "intermediate");
      const stagingFiles = existsSync(intermediateDir)
        ? (await import("node:fs")).readdirSync(intermediateDir).filter((f) => f.startsWith("staging-"))
        : [];
      expect(stagingFiles).toHaveLength(0);

      // 2. Final promoted file in output/ must exist and be non-empty
      const finalPath = resolveRunPath(runId, "output/reactor-note.docx", "output");
      expect(existsSync(finalPath)).toBe(true);

      // 3. ArtifactRef contract must have verified: true and verification details
      expect(art.verified).toBe(true);
      expect(art.filename).toBe("reactor-note.docx");
      expect(art.verificationDetails).toBeDefined();
      expect(art.verificationDetails?.paragraphCount).toBeGreaterThan(0);
    });

    it("stages, verifies, and promotes a valid XLSX deliverable with verified: true", async () => {
      const tableData = [
        "| Component | Observed (mm) | Allowable (mm) | Status |",
        "| Nozzle N-1 | 14.8 | 12.0 | Pass |",
        "| Shell Ring 2 | 22.1 | 20.0 | Pass |",
      ].join("\n");

      const art = await generateXlsxFromContent(runId, tableData, "thickness-data.xlsx", "Inspection Data");

      // 1. Staging file in intermediate/ must be cleaned up
      const intermediateDir = resolveRunPath(runId, "intermediate", "intermediate");
      const stagingFiles = existsSync(intermediateDir)
        ? (await import("node:fs")).readdirSync(intermediateDir).filter((f) => f.startsWith("staging-"))
        : [];
      expect(stagingFiles).toHaveLength(0);

      // 2. Promoted file exists
      const finalPath = resolveRunPath(runId, "output/thickness-data.xlsx", "output");
      expect(existsSync(finalPath)).toBe(true);

      // 3. ArtifactRef is verified
      expect(art.verified).toBe(true);
      expect(art.filename).toBe("thickness-data.xlsx");
      expect(art.verificationDetails?.sheetCount).toBeGreaterThanOrEqual(1);
      expect(art.verificationDetails?.rowCount).toBeGreaterThanOrEqual(2);
    });

    it("executes generateDeliverableTool for Markdown with staging, verification, and promotion", async () => {
      const mockContext: ToolExecutionContext = {
        runId,
        workspaceRoot: testRunDir,
        gateway: {} as any,
      };

      const mdContent = `# Engineering Assessment\n\n| Location | Reading | Unit |\n| Tank 1 | 98.4 | % |\n| Tank 2 | 92.1 | % |\n\nAll tank levels are within nominal operating limits.`;
      const res = await generateDeliverableTool.execute(
        {
          type: "md",
          filename: "tank-levels.md",
          content: mdContent,
        },
        mockContext,
      );

      // 1. Output string confirms real structural verification without hardcoded fake claims
      expect(res.output).toContain('Deliverable "tank-levels.md"');
      expect(res.output).toContain("File passed all structural verification checks (MD package validated)");
      expect(res.output).not.toContain("The file is compiled, verified, and saved to disk.");

      // 2. Artifact record exists and has verified: true
      expect(res.artifacts).toBeDefined();
      expect(res.artifacts).toHaveLength(1);
      const art = res.artifacts![0];
      expect(art.filename).toBe("tank-levels.md");
      expect(art.verified).toBe(true);
      expect(art.verificationDetails?.contentMatch).toBe(true);

      // 3. File promoted to output
      const outPath = resolveRunPath(runId, "output/tank-levels.md", "output");
      expect(existsSync(outPath)).toBe(true);
      const onDisk = readFileSync(outPath, "utf8");
      expect(onDisk).toBe(mdContent);

      // 4. Staging file in intermediate cleaned up
      const intermediateDir = resolveRunPath(runId, "intermediate", "intermediate");
      const stagingFiles = existsSync(intermediateDir)
        ? (await import("node:fs")).readdirSync(intermediateDir).filter((f) => f.startsWith("staging-"))
        : [];
      expect(stagingFiles).toHaveLength(0);
    });

    it("executes generateDeliverableTool for DOCX and emits verified output contract", async () => {
      const mockContext: ToolExecutionContext = {
        runId,
        workspaceRoot: testRunDir,
        gateway: {} as any,
      };

      const docContent = `# Turbine Vibration Analysis\n\nTurbine bearings inspected during overhaul. Peak vibration measurements recorded at 1.4 mm/s RMS, conforming to ISO standard limit of 2.8 mm/s.`;
      const res = await generateDeliverableTool.execute(
        {
          type: "docx",
          filename: "vibration-report.docx",
          content: docContent,
        },
        mockContext,
      );

      expect(res.output).toContain("DOCX package validated");
      expect(res.artifacts?.[0].verified).toBe(true);
      expect(res.artifacts?.[0].filename).toBe("vibration-report.docx");

      const outPath = resolveRunPath(runId, "output/vibration-report.docx", "output");
      expect(existsSync(outPath)).toBe(true);
    });

    it("rejects generateDeliverableTool when content is empty or placeholder only", async () => {
      const mockContext: ToolExecutionContext = {
        runId,
        workspaceRoot: testRunDir,
        gateway: {} as any,
      };

      await expect(
        generateDeliverableTool.execute(
          {
            type: "docx",
            filename: "placeholder.docx",
            content: "TODO",
          },
          mockContext,
        ),
      ).rejects.toThrow(/Cannot generate deliverable .* with placeholder or empty content/);
    });
  });
});
