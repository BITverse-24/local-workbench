import { existsSync, readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { artifactRef, resolveRunPath, writeRunFile } from "../run/filesystem.js";
import type { ArtifactRef, PythonExecutionResult } from "../../shared/contracts.js";

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(cur);
      cur = "";
    } else {
      cur += char;
    }
  }
  result.push(cur);
  return result;
}

export async function generateXlsx(runId: string, execution: PythonExecutionResult, requestedFilename?: string): Promise<ArtifactRef> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");

  let populated = false;
  const csvFile = execution.outputFiles.find((f) => /\.csv$/i.test(f));
  if (csvFile) {
    try {
      const csvPath = resolveRunPath(runId, `output/${csvFile}`, "output");
      if (existsSync(csvPath)) {
        const content = readFileSync(csvPath, "utf8");
        const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
        for (const line of lines) {
          sheet.addRow(parseCsvLine(line));
        }
        populated = true;
      }
    } catch {
      populated = false;
    }
  }

  if (!populated) {
    const lines = (execution.stdout || "").split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      for (const line of lines) {
        if (line.includes(",")) {
          sheet.addRow(parseCsvLine(line));
        } else if (line.includes("\t")) {
          sheet.addRow(line.split("\t"));
        } else {
          sheet.addRow([line]);
        }
      }
    } else {
      sheet.addRow(["Execution completed with exit code", execution.exitCode]);
    }
  }

  const data = await workbook.xlsx.writeBuffer();
  let candidate = requestedFilename?.trim() || "summary.xlsx";
  if (!/\.xlsx$/i.test(candidate)) {
    candidate = candidate.replace(/\.[^.]+$/, "") + ".xlsx";
  }
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*\.xlsx$/i.test(candidate) ? candidate : "summary.xlsx";
  const rel = writeRunFile(runId, "output", name, Buffer.from(data));
  return artifactRef(runId, "xlsx", name, rel);
}

