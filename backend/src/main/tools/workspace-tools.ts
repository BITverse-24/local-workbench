import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { listDir } from "../harness/tools/list-dir.js";
import { readFile } from "../harness/tools/read-file.js";
import { search } from "../harness/tools/search.js";
import { writeFile } from "../harness/tools/write-file.js";
import { deleteFile } from "../harness/tools/delete-file.js";
import { runCommand } from "../harness/tools/run-command.js";
import { resolveRunPath } from "../run/filesystem.js";
import type { ArtifactKind, ArtifactRef } from "../../shared/contracts.js";
import { isTextExtractableDocument, readDocumentContent } from "./document-reader.js";

function inferArtifactKind(filename: string): ArtifactKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".csv") return "csv";
  if (ext === ".json") return "json";
  if (ext === ".md") return "md";
  if (ext === ".pdf") return "pdf";
  return "txt";
}

export function extractPathArg(args: Record<string, unknown>): string {
  if (!args) return "";
  const candidateKeys = [
    "path", "filePath", "filepath", "file_path", "filename", "fileName",
    "file", "target", "destination", "dest", "targetPath", "target_path",
  ];
  for (const k of candidateKeys) {
    if (typeof args[k] === "string" && (args[k] as string).trim()) {
      return (args[k] as string).trim();
    }
  }

  for (const wrapper of ["parameters", "arguments", "input", "params"]) {
    const val = args[wrapper];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = extractPathArg(val as Record<string, unknown>);
      if (nested) return nested;
    } else if (typeof val === "string" && val.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object") {
          const nested = extractPathArg(parsed);
          if (nested) return nested;
        }
      } catch {}
    }
  }

  const rawStr = typeof args.raw === "string" ? args.raw : "";
  if (rawStr) {
    const m = rawStr.match(/["']?(?:path|filePath|file_path|filename|fileName|file|target)["']?\s*:\s*["']([^"'\r\n]+)["']/i);
    if (m && m[1]) return m[1].trim();
  }

  return "";
}

export function extractContentArg(args: Record<string, unknown>): string {
  if (!args) return "";
  const candidateKeys = [
    "content", "fileContent", "file_content", "code", "body", "text", "data",
  ];
  for (const k of candidateKeys) {
    if (typeof args[k] === "string") {
      return args[k] as string;
    }
  }

  for (const wrapper of ["parameters", "arguments", "input", "params"]) {
    const val = args[wrapper];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = extractContentArg(val as Record<string, unknown>);
      if (nested) return nested;
    } else if (typeof val === "string" && val.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed === "object") {
          const nested = extractContentArg(parsed);
          if (nested) return nested;
        }
      } catch {}
    }
  }

  const rawStr = typeof args.raw === "string" ? args.raw : "";
  if (rawStr) {
    const m = rawStr.match(/["']?(?:content|code|body|fileContent|text)["']?\s*:\s*["']([\s\S]*?)(?:["']\s*(?:,\s*["']|\})|$)/);
    if (m && m[1]) {
      return m[1]
        .replace(/["']\s*\}?\s*$/, "")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\");
    }
  }

  return "";
}

export function extractCommandArg(args: Record<string, unknown>): string {
  if (!args) return "";
  const candidateKeys = ["command", "cmd", "shell_command", "script", "exec"];
  for (const k of candidateKeys) {
    if (typeof args[k] === "string" && (args[k] as string).trim()) {
      return (args[k] as string).trim();
    }
  }
  for (const wrapper of ["parameters", "arguments", "input", "params"]) {
    const val = args[wrapper];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const nested = extractCommandArg(val as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  const rawStr = typeof args.raw === "string" ? args.raw : "";
  if (rawStr) {
    const m = rawStr.match(/["']?(?:command|cmd|shell_command|script|exec)["']?\s*:\s*["']([^"'\r\n]+)["']/i);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

export const listDirTool: AgentTool = {
  name: "list_dir",
  definition: {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories in the workspace. Returns names, types, and sizes in bytes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Relative path to list. Defaults to "." (root).' },
        },
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const relPath = extractPathArg(args) || ".";
    const entries = listDir(context.workspaceRoot, relPath);
    // Truncate listing if very large (guard context buffer)
    const truncatedEntries = entries.slice(0, 50);
    const summary = `Listed ${entries.length} items in "${relPath}"${entries.length > 50 ? " (showing first 50)" : ""}`;
    return {
      output: JSON.stringify(truncatedEntries, null, 2),
      summary,
    };
  },
};

/**
 * Resolves a file across run storage directories ('output', 'intermediate', 'input').
 */
export function findFileInRunDirectories(runId: string, relPath: string): string | null {
  const areas: Array<"output" | "intermediate" | "input"> = ["output", "intermediate", "input"];
  const base = path.basename(relPath);

  // 1. If relPath explicitly starts with an area prefix (e.g. "output/deliverable.docx")
  for (const area of areas) {
    if (relPath.startsWith(`${area}/`) || relPath.startsWith(`${area}\\`)) {
      try {
        const candidate = resolveRunPath(runId, relPath, area);
        if (existsSync(candidate)) return candidate;
      } catch {}
    }
  }

  // 2. Search each area directory directly for the filename or UUID-prefixed filename
  for (const area of areas) {
    try {
      const areaDir = resolveRunPath(runId, area, area);
      const directCandidate = path.join(areaDir, base);
      if (existsSync(directCandidate)) return directCandidate;

      if (existsSync(areaDir)) {
        const files = readdirSync(areaDir);
        const matched = files.find((f) => f === base || f.endsWith(`-${base}`));
        if (matched) {
          const matchedPath = path.join(areaDir, matched);
          if (existsSync(matchedPath)) return matchedPath;
        }
      }
    } catch {}
  }

  return null;
}

export const readFileTool: AgentTool = {
  name: "read_file",
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file content. Automatically extracts and formats readable text and tables from documents (.pdf, .docx, .txt, .md, code, etc.). Large files (>200KB) should be searched via search tool instead.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to file." },
        },
        required: ["path"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const relPath = extractPathArg(args);
    if (!relPath) {
      throw new Error(`path parameter is required. Received arguments: ${JSON.stringify(args).slice(0, 150)}. Expected format: {"path": "relative/path/to/file"}`);
    }

    // Native text parsing for PDF and Word (.docx) documents
    if (isTextExtractableDocument(relPath)) {
      let docPath: string | null = null;
      if (context.workspaceRoot) {
        try {
          const resolved = path.resolve(context.workspaceRoot, relPath);
          if (existsSync(resolved)) {
            docPath = resolved;
          }
        } catch {}
      }
      if (!docPath && context.runId) {
        docPath = findFileInRunDirectories(context.runId, relPath);
      }

      if (docPath) {
        const docResult = await readDocumentContent(docPath);
        let formattedContent = docResult.text;
        const lines = formattedContent.split("\n");
        if (lines.length > 400) {
          formattedContent = [
            ...lines.slice(0, 200),
            `\n... [TRUNCATED ${lines.length - 300} LINES — document exceeds single-turn budget] ...\n`,
            ...lines.slice(-100),
          ].join("\n");
        }
        if (formattedContent.length > 28000) {
          formattedContent = `${formattedContent.slice(0, 18000)}\n\n... [TRUNCATED ${formattedContent.length - 22000} CHARS — document exceeds single-turn budget] ...\n\n${formattedContent.slice(-4000)}`;
        }
        return {
          output: formattedContent,
          summary: docResult.summary,
        };
      }
    }

    let content: string;
    try {
      content = readFile(context.workspaceRoot, relPath);
    } catch (err) {
      if (context.runId) {
        const runFile = findFileInRunDirectories(context.runId, relPath);
        if (runFile) {
          content = readFileSync(runFile, "utf8");
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    const lines = content.split("\n");
    let formattedContent = content;
    if (lines.length > 300) {
      // Smart head/tail truncation for prompt budget preservation
      formattedContent = [
        ...lines.slice(0, 150),
        `\n... [TRUNCATED ${lines.length - 250} LINES — use search for specific sections] ...\n`,
        ...lines.slice(-100),
      ].join("\n");
    }
    if (formattedContent.length > 24000) {
      formattedContent = `${formattedContent.slice(0, 16000)}\n\n... [TRUNCATED ${formattedContent.length - 20000} CHARS — file exceeds context budget, use search tool for specific sections] ...\n\n${formattedContent.slice(-4000)}`;
    }
    return {
      output: formattedContent,
      summary: `Read "${relPath}" (${content.length} chars, ${lines.length} lines)`,
    };
  },
};

export const searchTool: AgentTool = {
  name: "search",
  definition: {
    type: "function",
    function: {
      name: "search",
      description: "Search for a text pattern across files in workspace using ripgrep.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The text pattern to search for." },
          path: { type: "string", description: 'Relative path to search within. Defaults to "."' },
        },
        required: ["query"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = String(args.query ?? args.search_query ?? args.pattern ?? args.text ?? args.q ?? "");
    const relPath = extractPathArg(args) || ".";
    if (!query) {
      throw new Error(`query parameter is required. Received arguments: ${JSON.stringify(args).slice(0, 150)}. Expected format: {"query": "pattern"}`);
    }
    const matches = search(context.workspaceRoot, query, relPath);
    const topMatches = matches.slice(0, 30);
    return {
      output: JSON.stringify(topMatches, null, 2),
      summary: `Found ${matches.length} matches for "${query}" in "${relPath}"`,
    };
  },
};

export const writeFileTool: AgentTool = {
  name: "write_file",
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file. Automatically creates timestamped backup before modifying.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to write to." },
          content: { type: "string", description: "The complete file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const relPath = extractPathArg(args);
    const content = extractContentArg(args);
    if (!relPath) {
      throw new Error(`path parameter is required. Received arguments: ${JSON.stringify(args).slice(0, 150)}. Expected format: {"path": "relative/path/to/file", "content": "..."}`);
    }
    const res = writeFile(context.workspaceRoot, relPath, content);
    if (context.harness) {
      try {
        context.harness.notifyWorkspaceTreeUpdated();
      } catch {}
    }

    // Mirror to run output directory as an artifact deliverable
    const artifacts: ArtifactRef[] = [];
    if (context.runId) {
      try {
        const baseName = path.basename(relPath);
        const outDir = resolveRunPath(context.runId, "output", "output");
        mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, baseName);
        writeFileSync(outPath, content, "utf8");
        const kind = inferArtifactKind(baseName);
        artifacts.push({
          artifactId: randomUUID(),
          runId: context.runId,
          kind,
          filename: baseName,
          relativePath: `runs/${context.runId}/output/${baseName}`,
          sizeBytes: Buffer.byteLength(content, "utf8"),
          createdAt: new Date().toISOString(),
        });
      } catch {}
    }

    return {
      output: JSON.stringify(res),
      summary: `Wrote "${relPath}" (${res.diff ?? "updated"})`,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      sideEffects: [`modified:${relPath}`],
    };
  },
};

export const deleteFileTool: AgentTool = {
  name: "delete_file",
  definition: {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file or directory from the workspace. Automatically creates timestamped backup.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to file or directory to delete." },
        },
        required: ["path"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const relPath = extractPathArg(args);
    if (!relPath) {
      throw new Error(`path parameter is required. Received arguments: ${JSON.stringify(args).slice(0, 150)}. Expected format: {"path": "relative/path/to/file"}`);
    }
    const res = deleteFile(context.workspaceRoot, relPath);
    if (context.harness) {
      try {
        context.harness.notifyWorkspaceTreeUpdated();
      } catch {}
    }
    return {
      output: JSON.stringify(res),
      summary: `Deleted "${relPath}"`,
      sideEffects: [`deleted:${relPath}`],
    };
  },
};

export const runCommandTool: AgentTool = {
  name: "run_command",
  definition: {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command with workspace directory as cwd. 60-second timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const command = extractCommandArg(args);
    if (!command) {
      throw new Error(`command parameter is required. Received arguments: ${JSON.stringify(args).slice(0, 150)}. Expected format: {"command": "npm test"}`);
    }
    const res = await runCommand(context.workspaceRoot, command);
    const summary = `Command exit ${res.exitCode} in ${res.durationMs}ms: "${command.slice(0, 40)}"`;
    return {
      output: JSON.stringify(res),
      summary,
      sideEffects: [`executed:${command.slice(0, 30)}`],
    };
  },
};

export const workspaceTools: AgentTool[] = [
  listDirTool,
  readFileTool,
  searchTool,
  writeFileTool,
  deleteFileTool,
  runCommandTool,
];
