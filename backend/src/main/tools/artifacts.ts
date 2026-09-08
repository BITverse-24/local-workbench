import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { artifactRef, absoluteDataPath, writeRunFile } from "../run/filesystem.js";
import type { ArtifactRef, DraftResult, PythonExecutionResult } from "../../shared/contracts.js";
const exec = promisify(execFile);
export async function generateDocx(runId: string, draft: DraftResult): Promise<ArtifactRef[]> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun({ text: draft.title, bold: true })] }),
          ...draft.sections.map((s) => new Paragraph(`${s.heading}\n${s.body}`)),
          new Paragraph(`References: ${draft.citations.map((c) => c.label).join(", ")}`),
        ],
      },
    ],
  });
  const data = await Packer.toBuffer(doc);
  const name = "approval-note-E201.docx";
  const rel = writeRunFile(runId, "output", name, data);
  const artifacts: ArtifactRef[] = [artifactRef(runId, "docx", name, rel)];
  const outputDir = absoluteDataPath(`runs/${runId}/output`);
  let pdfOk = false;
  try {
    await exec("libreoffice", ["--headless", "--convert-to", "pdf", "--outdir", outputDir, absoluteDataPath(rel)], { timeout: 60000 });
    pdfOk = true;
  } catch {
    try {
      await exec("soffice", ["--headless", "--convert-to", "pdf", "--outdir", outputDir, absoluteDataPath(rel)], { timeout: 60000 });
      pdfOk = true;
    } catch (e) {
      console.warn(`[artifacts] PDF conversion skipped (LibreOffice missing): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (pdfOk) {
    const pdfName = "approval-note-E201.pdf";
    const pdfRel = `runs/${runId}/output/${pdfName}`;
    artifacts.push(artifactRef(runId, "pdf", pdfName, pdfRel));
  }
  return artifacts;
}
export async function generateXlsx(runId: string, execution: PythonExecutionResult): Promise<ArtifactRef> { const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Out of range"); sheet.addRow(["Execution result", execution.stdout]); sheet.addRow(["Exit code", execution.exitCode]); const data = await workbook.xlsx.writeBuffer(); const name = "out-of-range-summary.xlsx"; const rel = writeRunFile(runId, "output", name, Buffer.from(data)); return artifactRef(runId, "xlsx", name, rel); }
