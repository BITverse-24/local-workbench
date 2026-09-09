import ExcelJS from "exceljs";
import { artifactRef, writeRunFile } from "../run/filesystem.js";
import type { ArtifactRef, PythonExecutionResult } from "../../shared/contracts.js";

export async function generateXlsx(runId: string, execution: PythonExecutionResult, requestedFilename?: string): Promise<ArtifactRef> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Execution summary");
  sheet.addRow(["Execution result", execution.stdout]);
  sheet.addRow(["Exit code", execution.exitCode]);
  sheet.addRow(["Output files", execution.outputFiles.join(", ")]);
  const data = await workbook.xlsx.writeBuffer();
  const candidate = requestedFilename?.trim() || "execution-summary.xlsx";
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*\.xlsx$/i.test(candidate) ? candidate : "execution-summary.xlsx";
  const rel = writeRunFile(runId, "output", name, Buffer.from(data));
  return artifactRef(runId, "xlsx", name, rel);
}
