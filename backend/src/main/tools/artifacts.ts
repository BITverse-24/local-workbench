import ExcelJS from "exceljs";
import { artifactRef, writeRunFile } from "../run/filesystem.js";
import type { ArtifactRef, PythonExecutionResult } from "../../shared/contracts.js";

export async function generateXlsx(runId: string, execution: PythonExecutionResult): Promise<ArtifactRef> { const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet("Out of range"); sheet.addRow(["Execution result", execution.stdout]); sheet.addRow(["Exit code", execution.exitCode]); const data = await workbook.xlsx.writeBuffer(); const name = "out-of-range-summary.xlsx"; const rel = writeRunFile(runId, "output", name, Buffer.from(data)); return artifactRef(runId, "xlsx", name, rel); }
