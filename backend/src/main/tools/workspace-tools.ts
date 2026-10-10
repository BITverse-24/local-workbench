import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseStructuredData } from "../gateway/structured-data.js";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { listDir } from "../harness/tools/list-dir.js";
import { readFile } from "../harness/tools/read-file.js";
import { search } from "../harness/tools/search.js";
import { writeFile } from "../harness/tools/write-file.js";
import { deleteFile } from "../harness/tools/delete-file.js";
import { runCommand } from "../harness/tools/run-command.js";
import { PermissionError, resolveSafe } from "../harness/path-guard.js";
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
    try {
      const parsed = JSON.parse(rawStr);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return extractContentArg(parsed);
      }
    } catch {}
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
  if(path.isAbsolute(relPath)||relPath.includes("\0")||relPath.split(/[\\/]/).includes(".."))throw new PermissionError("Run source path is not contained.");
  const areas: Array<"output" | "intermediate" | "input"> = ["output", "intermediate", "input"];
  const base = path.basename(relPath);

  // 1. If relPath explicitly starts with an area prefix (e.g. "output/deliverable.docx")
  for (const area of areas) {
    if (relPath.startsWith(`${area}/`) || relPath.startsWith(`${area}\\`)) {
      try {
        const candidate = resolveSafe(resolveRunPath(runId, area, area),relPath.slice(area.length+1));
        if (existsSync(candidate)) return candidate;
      } catch {}
    }
  }

  // 2. Search each area directory directly for the filename or UUID-prefixed filename
  for (const area of areas) {
    try {
      const areaDir = resolveRunPath(runId, area, area);
      const directCandidate = resolveSafe(areaDir, base);
      if (existsSync(directCandidate)) return directCandidate;

      if (existsSync(areaDir)) {
        const files = readdirSync(areaDir);
        const matched = files.find((f) => f === base || f.endsWith(`-${base}`));
        if (matched) {
          const matchedPath = resolveSafe(areaDir, matched);
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
    const safePath = resolveSafe(context.workspaceRoot, relPath);

    // Native text parsing for PDF and Word (.docx) documents
    if (isTextExtractableDocument(relPath)) {
      let docPath: string | null = null;
      if (context.workspaceRoot) {
        try {
          const resolved = safePath;
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
          intermediate: { type: "document", status: docResult.hasText ? "complete" : "partial", origin: "source_extracted", payload: docResult.text, sources: [{ filename: relPath, relation: "source" }] },
        };
      }
    }

    const ext = path.extname(relPath).toLowerCase();
    const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".ico"]);
    if (imageExtensions.has(ext)) {
      const output = `File "${relPath}" is a binary image (${ext.slice(1).toUpperCase()}). To inspect its contents, visual details, annotations, or extract text/measurements from it, use the 'extract_document' tool with filename: "${relPath}".`;
      return {
        output,
        summary: `Identified binary image "${relPath}" - advised extract_document`,
        intermediate: { type: "structured", status: "partial", origin: "source_extracted", payload: { filename: relPath, extension: ext, observation: output }, sources: [{ filename: relPath, relation: "source" }] },
      };
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
          const matches = context.indexedKnowledgeSources?.filter((source) => source.filename === relPath) ?? [];
          if ((err as NodeJS.ErrnoException).code === "ENOENT" && matches.length > 1) {
            throw new Error(`Multiple indexed sources are named "${relPath}". Use retrieve_knowledge with more context to disambiguate them.`);
          }
          const indexed = matches[0];
          if ((err as NodeJS.ErrnoException).code === "ENOENT" && indexed && context.grounding) {
            const result = await context.grounding.prepare({ runId: context.runId, text: relPath });
            const chunks = result.chunks?.filter((chunk) => chunk.docId === indexed.docId) ?? [];
            if (chunks.length) {
              return {
                output: chunks.map((chunk) => `[INDEXED SOURCE: ${indexed.filename}; CITATION: ${chunk.chunkId}; Page ${chunk.page}]\n${chunk.text}`).join("\n\n"),
                summary: `Read ${chunks.length} indexed excerpts from "${indexed.filename}" (knowledge base; no workspace file)`,
                intermediate: {
                  type: "document", status: "partial", origin: "source_extracted", payload: { chunks },
                  sources: chunks.map((chunk) => ({ filename: indexed.filename, page: chunk.page, locator: chunk.chunkId, relation: "source" as const })),
                },
              };
            }
          }
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
      intermediate: { type: "text", status: "complete", origin: "source_extracted", payload: content, sources: [{ filename: relPath, relation: "source" }] },
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
      description: "Write UTF-8 text or source code to a file. Use generate_deliverable for Word, Excel and PDF documents. Automatically creates timestamped backup before modifying.",
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

    if (/\.(?:docx|xlsx|pdf)$/i.test(relPath)) {
      throw { code: "invalid_arguments", retryable: true,
        message: "write_file writes UTF-8 text and cannot create or revise a Word, Excel or PDF document. Use generate_deliverable with the document type, filename and complete revised content; it compiles a valid document." };
    }

    if (/^test[_-]|_test\.[a-z0-9]+$/i.test(path.basename(relPath)) && !context.policyGuard?.isAuthorized(context.runId, "write_file", { path: relPath })) {
      throw {
        code: "invalid_arguments",
        retryable: true,
        message: `Do not write test helper file "${relPath}". Run tests inline with run_command using python_code or command.`,
      };
    }

    if (context.policyGuard && context.policyGuard.isEnforcingExplicit(context.runId)) {
      const isAuth = context.policyGuard.isAuthorized(context.runId, "write_file", { path: relPath });
      if (!isAuth) {
        throw new PermissionError(`Operation not authorized: write_file ${relPath}`);
      }
    }

    const lockKey = `file:${relPath}`;
    const res = context.policyGuard
      ? await context.policyGuard.withMutationLock(lockKey, () =>
          writeFile(context.workspaceRoot, relPath, content),
        )
      : writeFile(context.workspaceRoot, relPath, content);

    if (context.harness) {
      try {
        context.harness.notifyWorkspaceTreeUpdated();
      } catch {}
    }

    // Legacy callers mirror writes; V2 workspace changes are independent of exports.
    const artifacts: ArtifactRef[] = [];
    if (context.runId && !context.runContract) {
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

    if (relPath.endsWith(".py") && relPath.includes("-")) {
      try {
        const alias = relPath.replace(/-/g, "_");
        const fullAlias = path.resolve(context.workspaceRoot, alias);
        fs.writeFileSync(fullAlias, content, "utf8");
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

    if (context.policyGuard && context.policyGuard.isEnforcingExplicit(context.runId)) {
      const isAuth = context.policyGuard.isAuthorized(context.runId, "delete_file", { path: relPath });
      if (!isAuth) {
        throw new PermissionError(`Operation not authorized: delete_file ${relPath}`);
      }
    }

    const lockKey = `file:${relPath}`;
    const res = context.policyGuard
      ? await context.policyGuard.withMutationLock(lockKey, () =>
          deleteFile(context.workspaceRoot, relPath),
        )
      : deleteFile(context.workspaceRoot, relPath);

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

export function normalizeRunCommandArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.python_module !== undefined) {
    try {
      if (!Array.isArray(args.python_reference_pipeline)) throw new Error("independent reference required");
      const testCase = args.python_text_rows !== undefined
        ? { text_rows: args.python_text_rows }
        : { args: typeof args.python_args_json === "string" ? parseStructuredData(args.python_args_json) : undefined };
      const normalized = normalizeRunCommandArgs({ ...args, python_validation: {
        module: args.python_module, function: args.python_function, cases: [testCase], reference_pipeline: args.python_reference_pipeline, success_marker: args.success_marker,
      }, python_module: undefined });
      return { ...normalized, python_module: args.python_module };
    } catch { return { ...args, raw: JSON.stringify(args) }; }
  }
  if (args.python_validation !== undefined) {
    const spec = args.python_validation as any;
    const identifier = /^[A-Za-z_]\w*$/;
    const moduleName = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
    const reference = spec?.reference_pipeline;
    const hasReference = Array.isArray(reference) && reference.length > 0 && reference.every((step: unknown) => {
      if (typeof step !== "string") return false;
      const [module, fn, extra] = step.split(":");
      return !extra && moduleName.test(module) && identifier.test(fn ?? "") && !(module === spec.module && fn === spec.function);
    });
    if (!spec || typeof spec !== "object" || typeof spec.module !== "string" || typeof spec.function !== "string" ||
        !moduleName.test(spec.module) || !identifier.test(spec.function) ||
        (reference !== undefined && !hasReference) ||
        !Array.isArray(spec.cases) || !spec.cases.length ||
        spec.cases.some((item: any) => !item ||
          !(Array.isArray(item.args) || (Array.isArray(item.text_rows) && item.text_rows.every((row: unknown) => typeof row === "string"))) ||
          (item.text_rows !== undefined && (!Array.isArray(item.text_rows) || !item.text_rows.every((row: unknown) => typeof row === "string"))) ||
          (!hasReference && (!Object.prototype.hasOwnProperty.call(item, "expected") || item.expected === undefined)) ||
          (item.kwargs !== undefined && (!item.kwargs || typeof item.kwargs !== "object" || Array.isArray(item.kwargs)))) ||
        (spec.success_marker !== undefined && typeof spec.success_marker !== "string")) {
      return { ...args, raw: JSON.stringify(args) };
    }
    // Only supplied JSON values enter the generic assertion driver. Module and
    // function names are identifiers; cases are decoded as data, never source.
    const encoded = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
    const pythonCode = `import base64, copy, importlib, json
spec = json.loads(base64.b64decode("${encoded}"))
target = getattr(importlib.import_module(spec["module"]), spec["function"])
for case in spec["cases"]:
    arguments = [chr(10).join(case["text_rows"])] if "text_rows" in case else case["args"]
    if spec.get("reference_pipeline"):
        reference_args = copy.deepcopy(arguments)
        for index, step in enumerate(spec["reference_pipeline"]):
            module, function = step.split(":")
            reference = getattr(importlib.import_module(module), function)
            expected = reference(*reference_args) if index == 0 else reference(expected)
    else:
        expected = case["expected"]
    actual = target(*arguments, **case.get("kwargs", {}))
    assert actual == expected, (actual, expected)
if spec.get("success_marker"):
    print(spec["success_marker"])`;
    const normalized = normalizeRunCommandArgs({ python_code: pythonCode });
    return { ...args, python_code: pythonCode, command: normalized.command };
  }
  if (typeof args.python_code !== "string" || !args.python_code.trim()) return args;
  // A quoted heredoc preserves Python/CSV quotes and literal backslashes. Choose
  // a delimiter absent from the supplied body, never interpreting it as shell.
  const hyphenShim = `import sys, os, importlib.util
from importlib.abc import MetaPathFinder
class _WorkbenchHyphenFinder(MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        alt = fullname.replace('_', '-') + '.py'
        if os.path.exists(alt):
            return importlib.util.spec_from_file_location(fullname, alt)
        return None
if not any(isinstance(f, _WorkbenchHyphenFinder) for f in sys.meta_path):
    sys.meta_path.insert(0, _WorkbenchHyphenFinder())
`;
  const wrappedCode = `${hyphenShim}\n${args.python_code}`;
  let delimiter = "WORKBENCH_PYTHON";
  const lines = wrappedCode.split(/\r?\n/);
  while (lines.includes(delimiter)) delimiter += "_";
  return { ...args, command: `python3 -B - <<'${delimiter}'\n${wrappedCode}\n${delimiter}` };
}

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
          command: { type: "string", description: "The shell command to execute. For Python function checks set command to 'python3 -B', provide python_module, python_function, inputs and python_reference_pipeline. The complete assertion command is constructed before authorization." },
          python_module: { type: "string", description: "For Python function checks: importable written workspace module name without .py." },
          python_function: { type: "string", description: "Name of the function to call in python_module." },
          python_text_rows: { type: "array", items: { type: "string" }, description: "For one text argument, supply raw input lines as separate strings. Joined with real newlines; use an empty string for a blank row." },
          python_args_json: { type: "string", description: "Alternative to python_text_rows: positional arguments serialized as a standard JSON array." },
          python_reference_pipeline: { type: "array", items: { type: "string" }, description: "Required with python_module: independent reference callables in module:function format, applied in order to the same inputs. The first receives the input arguments; each later callable receives the preceding result. Cannot reference the function being tested. Results are computed, never invented." },
          success_marker: { type: "string", description: "Optional requested marker, printed only after the function result matches expected." },
          python_code: { type: "string", description: "Optional complete Python validation code, at most 20 lines using a loop over at most six distinct cases. Import all referenced libraries and the written workspace module. Call its function and use bare assert expressions (no formatted error strings), then print the requested success marker. Pass ordinary code with JSON escapes, without shell quoting. Runs in the workspace and creates no helper or bytecode file." },
        },
        required: ["command"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const normalizedArgs = normalizeRunCommandArgs(args);
    if (typeof normalizedArgs.raw === "string") {
      throw { code: "invalid_arguments", message: "Invalid Python validation: supply module, function and nonempty inputs plus expected results or an independent module:function reference pipeline. No command was executed.", retryable: true };
    }
    const command = extractCommandArg(normalizedArgs);
    if (!command) {
      throw new Error(`command parameter is required. Received arguments: ${JSON.stringify(args).slice(0, 150)}. Expected format: {"command": "npm test"}`);
    }

    if (context.policyGuard && context.policyGuard.isEnforcingExplicit(context.runId)) {
      const isAuth = context.policyGuard.isAuthorized(context.runId, "run_command", { command });
      if (!isAuth) {
        throw new PermissionError(`Operation not authorized: run_command ${command}`);
      }
    }

    try {
      const entries = fs.readdirSync(context.workspaceRoot);
      for (const entry of entries) {
        if (entry.endsWith(".py") && entry.includes("-")) {
          const alias = entry.replace(/-/g, "_");
          const target = path.join(context.workspaceRoot, alias);
          if (!fs.existsSync(target)) {
            try {
              fs.symlinkSync(entry, target);
            } catch {
              fs.copyFileSync(path.join(context.workspaceRoot, entry), target);
            }
          }
        }
      }
    } catch {}

    const res = context.policyGuard
      ? await context.policyGuard.withMutationLock("workspace:run_command", () =>
          runCommand(context.workspaceRoot, command),
        )
      : await runCommand(context.workspaceRoot, command);

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
