import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ToolExecutionContext } from "../../tools/types.js";
import { parseFileIndependently, type ParsedFile } from "../../tools/file-worker.js";
import { runRoot, resolveRunPath } from "../filesystem.js";
import { resolveSafe } from "../../harness/path-guard.js";
import { generateDeliverableTool } from "../../tools/specialist-tools.js";

export interface ReadTableOptions {
  sheet?: string;
  columns?: string[];
  limit?: number;
  offset?: number;
}

export interface ReadTextOptions {
  startLine?: number;
  maxLines?: number;
}

export interface TableSchemaInfo {
  sheets: Array<{
    name: string;
    rowCount: number;
    columns: string[];
  }>;
}

export interface DeliverableOptions {
  type: "xlsx" | "csv" | "json" | "docx" | "md" | "txt";
  filename: string;
  content: string;
}

export interface WorkFacade {
  readTable(filename: string, options?: ReadTableOptions): Promise<Array<Record<string, unknown>>>;
  readJson<T = unknown>(filename: string): Promise<T>;
  readText(filename: string, options?: ReadTextOptions): Promise<string>;
  readDocument(filename: string): Promise<{ text: string; headings: string[]; pageCount: number }>;
  getTableSchema(filename: string): Promise<TableSchemaInfo>;
  emitDeliverable(options: DeliverableOptions): Promise<{ ok: boolean; filename: string; artifactId?: string }>;
  text(output: string): void;
  getTextOutput(): string | null;
  getExecutedDeliverables(): Array<{ filename: string; artifactId?: string }>;
  getDiscoveredDigests(): string[];
}

export function createWorkFacade(context: ToolExecutionContext): WorkFacade {
  let textOutput: string | null = null;
  const executedDeliverables: Array<{ filename: string; artifactId?: string }> = [];
  const discoveredDigests = new Set<string>();

  // Helper to locate an attached file in input or output storage
  const locateFile = (filename: string): { filePath: string; extension: string } => {
    const clean = path.basename(filename);
    const runDir = runRoot(context.runId);

    // 1. Search in input sources from context
    if (context.inputSources) {
      const match = context.inputSources.find(
        (s) => s.filename === clean || s.filename === filename || s.id === filename,
      );
      if (match) {
        const prefix = `runs/${context.runId}/`;
        const rel = match.relativePath.startsWith(prefix)
          ? match.relativePath.slice(prefix.length)
          : match.relativePath;
        const inputDir = path.join(runDir, "input");
        const cleanRel = rel.replace(/^input\//, "");
        const filePath = resolveSafe(inputDir, cleanRel);
        if (existsSync(filePath)) {
          return { filePath, extension: path.extname(clean).slice(1).toLowerCase() };
        }
      }
    }

    // 2. Search inside runs/<runId>/input/ directory
    const inputDir = path.join(runDir, "input");
    if (existsSync(inputDir)) {
      const entries = readdirSync(inputDir);
      const exact = entries.find((e) => e === clean || e.endsWith(`-${clean}`));
      if (exact) {
        const filePath = resolveSafe(inputDir, exact);
        return { filePath, extension: path.extname(clean).slice(1).toLowerCase() };
      }
    }

    // 3. Search inside runs/<runId>/output/ directory
    const outputDir = path.join(runDir, "output");
    if (existsSync(outputDir)) {
      const entries = readdirSync(outputDir);
      const exact = entries.find((e) => e === clean);
      if (exact) {
        const filePath = resolveSafe(outputDir, exact);
        return { filePath, extension: path.extname(clean).slice(1).toLowerCase() };
      }
    }

    throw new Error(`Attached file "${filename}" could not be found in run storage.`);
  };

  const getParsedData = async (filename: string): Promise<ParsedFile> => {
    const { filePath, extension } = locateFile(filename);
    const bytes = readFileSync(filePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    discoveredDigests.add(digest);
    return await parseFileIndependently(filePath, extension);
  };

  return {
    async readTable(filename: string, options: ReadTableOptions = {}) {
      const parsed = await getParsedData(filename);

      let headers: string[] = [];
      let dataRows: (string | number | boolean | null)[][] = [];

      if (parsed.rows.length > 0) {
        headers = (parsed.columns[0] ?? (parsed.rows[0] as string[])).map((h) => String(h ?? ""));
        dataRows = parsed.rows.slice(1);
      }

      // Apply offset and limit
      const offset = options.offset ?? 0;
      const limit = options.limit !== undefined ? options.limit : dataRows.length;
      const sliced = dataRows.slice(offset, offset + limit);

      // Filter columns if specified
      const selectedColumns = options.columns
        ? new Set(options.columns.map((c) => c.toLowerCase()))
        : null;

      const result: Array<Record<string, unknown>> = [];
      for (const row of sliced) {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < headers.length; i++) {
          const header = headers[i] || `col_${i}`;
          if (!selectedColumns || selectedColumns.has(header.toLowerCase())) {
            obj[header] = row[i] !== undefined ? row[i] : null;
          }
        }
        result.push(obj);
      }

      return result;
    },

    async readJson<T = unknown>(filename: string): Promise<T> {
      const parsed = await getParsedData(filename);
      if (parsed.json !== undefined) {
        return parsed.json as T;
      }
      return JSON.parse(parsed.text) as T;
    },

    async readText(filename: string, options: ReadTextOptions = {}): Promise<string> {
      const parsed = await getParsedData(filename);
      if (options.startLine === undefined && options.maxLines === undefined) {
        return parsed.text;
      }
      const lines = parsed.text.split("\n");
      const start = options.startLine ? Math.max(0, options.startLine - 1) : 0;
      const max = options.maxLines ?? lines.length;
      return lines.slice(start, start + max).join("\n");
    },

    async readDocument(filename: string) {
      const parsed = await getParsedData(filename);
      return {
        text: parsed.text,
        headings: parsed.headings,
        pageCount: parsed.pages?.length ?? 1,
      };
    },

    async getTableSchema(filename: string): Promise<TableSchemaInfo> {
      const parsed = await getParsedData(filename);
      const sheetNames = parsed.sheets.length > 0 ? parsed.sheets : ["Sheet1"];
      const sheets = sheetNames.map((name, i) => ({
        name,
        rowCount: parsed.rowCount,
        columns: parsed.columns[i] ?? parsed.columns[0] ?? [],
      }));
      return { sheets };
    },

    async emitDeliverable(options: DeliverableOptions) {
      const result = await generateDeliverableTool.execute(
        {
          type: options.type,
          filename: options.filename,
          content: options.content,
        },
        context,
      );

      if (result.ok === false || result.error) {
        throw new Error(`Deliverable generation failed: ${result.error?.message ?? result.output}`);
      }

      const artifactId = result.artifacts?.[0]?.artifactId;
      executedDeliverables.push({ filename: options.filename, artifactId });
      return { ok: true, filename: options.filename, artifactId };
    },

    text(output: string) {
      textOutput = output;
    },

    getTextOutput() {
      return textOutput;
    },

    getExecutedDeliverables() {
      return executedDeliverables;
    },

    getDiscoveredDigests() {
      return Array.from(discoveredDigests);
    },
  };
}
