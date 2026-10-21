import { reviewProposedPython } from "../agent/source-review.js";
import { assertRuntimeActive } from "../run/runtime-scope.js";
import { parseFileIndependently } from "./file-worker.js";
import { withTaskProgress } from "../run/task-progress.js";
import { createHash, randomUUID } from "node:crypto";
import { matchesContractDeliverable } from "../run/contract.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from 'zod';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { resolveSafe } from "../harness/path-guard.js";
import { requestBase } from "../gateway/model-gateway.js";
import { executePython } from "./python.js";
import { buildPythonBehaviorValidationRunner, buildPythonReturnValidationRunner } from "./python-contract.js";
import { generateDocx, generateXlsxFromContent, verifyArtifactFile } from "./artifacts.js";
import { resolveRunPath, writeRunFile, artifactRef, dataRoot, absoluteDataPath, createRunDirectories } from "../run/filesystem.js";
import { extractContentArg, extractPathArg, findFileInRunDirectories } from "./workspace-tools.js";
import type {
  ArtifactKind,
  ArtifactRef,
  CodeModelRequest,
  DraftModelRequest,
  ModelId,
  VisionModelRequest,
} from "../../shared/contracts.js";
import { extractDocxText, extractPdfText } from "./document-reader.js";
import { extractSvgText } from "../run/images.js";

function inferArtifactKind(filename: string): ArtifactKind {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".docx") return "docx";
  if (ext === ".xlsx") return "xlsx";
  if (ext === ".csv") return "csv";
  if (ext === ".py") return "txt";
  if (ext === ".json") return "json";
  if (ext === ".md") return "md";
  if (ext === ".pdf") return "pdf";
  return "txt";
}

/**
 * 1. extract_document: Dispatches multimodal document/image inspection to vision model.
 */
export const extractDocumentTool: AgentTool = {
  name: "extract_document",
  definition: {
    type: "function",
    function: {
      name: "extract_document",
      description: "Extract source text, tables, annotations and visual evidence from an attached document or image.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "The filename of the attached document or image to inspect." },
          query: { type: "string", description: "Specific extraction instruction or focus area from the user request." },
        },
        required: ["filename"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const rawPath = extractPathArg(args) || String(args.filename ?? args.path ?? args.document ?? args.file ?? "");
    const cleanRawPath = rawPath.trim().replace(/^['"]|['"]$/g, "");
    if (path.isAbsolute(cleanRawPath)||cleanRawPath.includes("\0")||cleanRawPath.split(/[\\/]/).includes(".."))throw {code:"permission_denied",retryable:false,message:"Document sources require a contained relative path."};
    if (!cleanRawPath) {
      throw new Error(`extract_document requires a filename or path parameter. Received: ${JSON.stringify(args)}`);
    }
    const query = String(args.query ?? args.prompt ?? args.instruction ?? args.focus ?? args.task ?? "Extract source text, tables, annotations and visual evidence from this document.");

    let filePath: string | null = null;
    if (context.workspaceRoot) {
      try {
        const resolved = resolveSafe(context.workspaceRoot, cleanRawPath);
        if (existsSync(resolved)) filePath = resolved;
      } catch {}
    }
    if (!filePath && context.runId) {
      filePath = findFileInRunDirectories(context.runId, cleanRawPath);
    }

    if (!filePath || !existsSync(filePath)) {
      throw new Error(`Attached file "${cleanRawPath}" not found in run directories or workspace`);
    }

    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();

    // 1. Native Word document extraction (DOCX)
    if (ext === ".docx" || ext === ".doc") {
      const docxRes = await extractDocxText(filePath);
      const pageReferences = [{ id: "doc-1", page: 1, text: docxRes.text.slice(0, 1000) }];
      const findings = [
        {
          findingId: "f-1",
          title: `Document Content: ${filename}`,
          value: docxRes.text.slice(0, 500),
          pageReferenceIds: ["doc-1"],
          confidence: "high",
          evidence: docxRes.text.slice(0, 300),
        },
      ];
      const docResult = {
        sourceText: docxRes.text,
        extractionMethod: "digital_document",
        pageReferences,
        findings,
      };
      return {
        output: JSON.stringify(docResult, null, 2),
        summary: `Extracted text from Word document "${filename}" (${docxRes.totalChars} chars)`,
        intermediate: { type: "document", status: "complete", origin: "source_extracted", payload: docResult, sources: [{ filename: cleanRawPath, relation: "source" }] },
      };
    }

    // 2. Native PDF text extraction (digital PDF with text layer)
    if (ext === ".pdf") {
      try {
        const pdfRes = await extractPdfText(filePath);
        if (pdfRes.hasText) {
          const pageReferences = pdfRes.pages.map((p) => ({
            id: `page-${p.pageNumber}`,
            page: p.pageNumber,
            text: p.text.slice(0, 1000),
          }));
          const findings = pdfRes.pages.map((p) => ({
            findingId: `finding-p${p.pageNumber}`,
            title: `Page ${p.pageNumber} Content: ${filename}`,
            value: p.text.slice(0, 500),
            pageReferenceIds: [`page-${p.pageNumber}`],
            confidence: "high",
            evidence: p.text.slice(0, 300),
          }));
          const digitalResult = {
            sourceText: pdfRes.text,
            extractionMethod: "digital_text",
            numPages: pdfRes.numPages,
            pageReferences,
            findings,
          };
          return {
            output: JSON.stringify(digitalResult, null, 2),
            summary: `Extracted digital text across ${pdfRes.numPages} pages from "${filename}" (${pdfRes.totalChars} chars)`,
            intermediate: { type: "document", status: "complete", origin: "source_extracted", payload: { ...digitalResult, pages: pdfRes.pages }, sources: pdfRes.pages.map((p) => ({ filename: cleanRawPath, page: p.pageNumber, relation: "source" as const })) },
          };
        }
      } catch (err) {
        // If digital extraction failed, fall through to multimodal vision request below
        console.warn(`[extract_document] digital extraction failed for "${filename}", falling back to vision:`, err);
      }
    }

    // 3. Native SVG vector drawing text extraction
    if (ext === ".svg") {
      try {
        const raw = readFileSync(filePath);
        const svgText = extractSvgText(raw, null);
        if (svgText && svgText.trim().length > 0) {
          const pageReferences = [{ id: "svg-1", page: 1, text: svgText.slice(0, 1000) }];
          const findings = [
            {
              findingId: "svg-f1",
              title: `Vector Drawing Content: ${filename}`,
              value: svgText.slice(0, 500),
              pageReferenceIds: ["svg-1"],
              confidence: "high",
              evidence: svgText.slice(0, 300),
            },
          ];
          const svgResult = {
            sourceText: svgText,
            extractionMethod: "digital_svg",
            pageReferences,
            findings,
          };
          return {
            output: JSON.stringify(svgResult, null, 2),
            summary: `Extracted vector diagram text and annotations from SVG "${filename}" (${svgText.length} chars)`,
            intermediate: { type: "document", status: "complete", origin: "source_extracted", payload: svgResult, sources: [{ filename: cleanRawPath, relation: "source" }] },
          };
        }
      } catch (err) {
        console.warn(`[extract_document] digital SVG extraction failed for "${filename}", falling back to vision:`, err);
      }
    }

    // 4. Multimodal vision fallback (for scanned PDFs, photos, and engineering drawings)
    const mediaType = ext === ".pdf"
      ? "application/pdf"
      : ext === ".svg"
      ? "image/svg+xml"
      : ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : "application/octet-stream";

    const entries = [...(context.gateway.registry?.values() ?? [])];
    const preferred = entries.find(entry => entry.id === context.runContract?.routing?.driverModel && entry.enabled && entry.capabilities.includes("image-input"));
    const imageModel = preferred ?? entries.find(entry => entry.enabled && entry.capabilities.includes("image-input"));
    if (!imageModel) throw new Error("Visual extraction requires an enabled model with image-input capability; none is configured.");
    const targetModelId = imageModel.id;

    const base = requestBase(
      context.runId,
      "vision",
      targetModelId,
      "vision-result",
      "Extract document text, tables, annotations and visual evidence accurately. Preserve source subjects, layout and page locations. Do not infer missing content.",
      query,
      60000,
      imageModel.maxOutputTokens ?? 1024,
      imageModel.temperature ?? 0,
    );

    const sourceRelativePath = path.relative(dataRoot(), filePath);
    const attachmentPath = sourceRelativePath.startsWith("..") || path.isAbsolute(sourceRelativePath)
      ? writeRunFile(context.runId, "intermediate", `${randomUUID()}-${filename}`, readFileSync(filePath))
      : sourceRelativePath;
    const requestId = randomUUID();
    const req: VisionModelRequest = {
      ...base,
      requestId,
      taskType: "vision",
      modelId: targetModelId,
      responseFormat: "vision-result",
      attachment: {
        attachmentId: randomUUID(),
        filename,
        mediaType,
        sizeBytes: statSync(filePath).size,
        relativePath: attachmentPath,
      },
      inputMode: "typed-scan",
      parentToolCallId: context.currentCallId,
    };

    context.emitRunEvent?.({
      type: "routing",
      runId: context.runId,
      taskType: "vision",
      modelId: targetModelId,
      reason: targetModelId === context.runContract?.routing?.driverModel
        ? `Visual extraction: ${filename}`
        : `Vision fallback model for ${filename}`,
      tier: "vision",
    });

    const resp = await context.gateway.execute(req);
    if (!resp.ok) {
      throw new Error(`Document extraction failed: ${resp.error.message}`);
    }

    const visionResult = resp.value.result as any;
    const findings = visionResult.findings ?? [];
    const summary = `Extracted ${findings.length} findings from "${filename}"`;
    return {
      output: JSON.stringify(visionResult, null, 2),
      summary,
      intermediate: { type: "document", status: "complete", origin: "model_derived", payload: visionResult, sources: [{ filename: cleanRawPath, relation: "input" }] },
    };
  },
};

/**
 * 2. generate_code: Cross-model delegation to code specialist model (e.g. qwen2.5-coder).
 */
const generateCodeImplementation: AgentTool = {
  name: "generate_code",
  definition: {
    type: "function",
    function: {
      name: "generate_code",
      description: "Ask the code specialist model to write, repair, or refactor source code based on a specification.",
      parameters: {
        type: "object",
        properties: {
          spec: { type: "string", description: "Detailed specification of the code to generate, input files, expected logic, and output files." },
          language: { type: "string", description: "Programming language (e.g. 'python', 'typescript'). Defaults to 'python'." },
          filename: { type: "string", description: "Target script filename (e.g. 'task.py', 'parser.py')." },
        },
        required: ["spec"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    let effectiveArgs = args;
    if (typeof args.raw === "string" && args.raw.trim().startsWith("{")) {
      try {
        effectiveArgs = { ...args, ...JSON.parse(args.raw) };
      } catch {}
    }
    for (const wrapper of ["parameters", "arguments", "input", "params"]) {
      const val = effectiveArgs[wrapper];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        effectiveArgs = { ...effectiveArgs, ...(val as Record<string, unknown>) };
      }
    }
    const spec = String(effectiveArgs.spec ?? effectiveArgs.prompt ?? effectiveArgs.task ?? effectiveArgs.instruction ?? effectiveArgs.description ?? effectiveArgs.code_spec ?? "");
    const filename = String(effectiveArgs.filename ?? effectiveArgs.path ?? effectiveArgs.file ?? "task.py");
    if (!spec.trim()) {
      throw new Error("generate_code requires a 'spec' or 'prompt' description of the code to generate.");
    }
    const targetModelId = (context.gateway?.registry?.has("primary-model")
      ? "primary-model"
      : context.runContract?.routing?.driverModel ?? "primary-model") as ModelId;

    const base = requestBase(
      context.runId,
      "code",
      targetModelId,
      "code-result",
      "You are an expert software engineer. Generate robust, production-grade code that satisfies the specification without external internet dependencies.",
      spec,
      60000,
      4096,
      0.1,
    );

    const req: CodeModelRequest = {
      ...base,
      requestId: randomUUID(),
      taskType: "code",
      modelId: targetModelId,
      responseFormat: "code-result",
      task: spec,
      inputFile: { attachmentId: randomUUID(), filename, mediaType: "text/x-python", rowCount: 1 },
      allowedLanguage: "python",
      executionRules: ["sandbox-isolated"],
      parentToolCallId: context.currentCallId,
    };

    const resp = await context.gateway.execute(req);
    if (!resp.ok) {
      throw new Error(`Code generation failed: ${resp.error.message}`);
    }

    const codeResult = resp.value.result as any;
    const source = codeResult.source ?? "";
    return {
      output: JSON.stringify({ filename: codeResult.filename ?? filename, source, expectedResult: codeResult.expectedResult }),
      summary: `Generated code for "${codeResult.filename ?? filename}" (${source.split("\n").length} lines)`,
    };
  },
};

/**
 * 3. generate_text: Cross-model delegation to draft/reasoning specialist model (e.g. qwen3:8b).
 */
export const generateCodeTool = observeGeneration(generateCodeImplementation, "repair_generation");

const generateTextImplementation: AgentTool = {
  name: "generate_text",
  definition: {
    type: "function",
    function: {
      name: "generate_text",
      description: "Ask the drafting and reasoning specialist model to synthesize reports, formal notes, or analysis.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The writing or synthesis prompt." },
          context: { type: "string", description: "Factual observations, extracted findings, or data tables to incorporate." },
        },
        required: ["prompt"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    let effectiveArgs = args;
    if (typeof args.raw === "string" && args.raw.trim().startsWith("{")) {
      try {
        effectiveArgs = { ...args, ...JSON.parse(args.raw) };
      } catch {}
    }
    for (const wrapper of ["parameters", "arguments", "input", "params"]) {
      const val = effectiveArgs[wrapper];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        effectiveArgs = { ...effectiveArgs, ...(val as Record<string, unknown>) };
      }
    }
    const prompt = String(effectiveArgs.prompt ?? effectiveArgs.text ?? effectiveArgs.query ?? effectiveArgs.instruction ?? effectiveArgs.spec ?? "");
    const extraContext = (effectiveArgs.context || effectiveArgs.data || effectiveArgs.findings || effectiveArgs.input)
      ? `\n\nCONTEXT:\n${String(effectiveArgs.context ?? effectiveArgs.data ?? effectiveArgs.findings ?? effectiveArgs.input)}`
      : "";
    if (!prompt.trim()) {
      throw new Error("generate_text requires a 'prompt' or 'instruction' for the text to draft.");
    }
    const targetModelId = (context.gateway?.registry?.has("primary-model")
      ? "primary-model"
      : context.runContract?.routing?.driverModel ?? "primary-model") as ModelId;

    const base = requestBase(
      context.runId,
      "draft",
      targetModelId,
      "chat-result",
      "You are a technical engineering drafting assistant. Produce clear, formal, publication-grade documentation grounded strictly in provided evidence.",
      `${prompt}${extraContext}`,
      45000,
      4096,
      0.2,
    );

    const resp = await context.gateway.execute({
      ...base,
      requestId: randomUUID(),
      taskType: "draft",
      modelId: targetModelId,
      responseFormat: "chat-result",
      parentToolCallId: context.currentCallId,
    } as any);

    if (!resp.ok) {
      throw new Error(`Text drafting failed: ${resp.error.message}`);
    }

    const text = (resp.value.result as any)?.text ?? "";
    return {
      output: text,
      summary: `Drafted ${text.length} characters of technical text`,
    };
  },
};

/**
 * 4. retrieve_knowledge: Local vector RAG query into ChromaDB for SOPs and standards.
 */
export const generateTextTool = observeGeneration(generateTextImplementation, "draft_generation");

export const retrieveKnowledgeTool: AgentTool = {
  name: "retrieve_knowledge",
  definition: {
    type: "function",
    function: {
      name: "retrieve_knowledge",
      description: "Search indexed standard operating procedures (SOPs), governing specifications, and technical rules via local ChromaDB RAG.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Combined query for the required governing criteria." },
        },
        required: ["query"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = String(args.query ?? args.search ?? args.question ?? args.prompt ?? args.text ?? "");
    if (!query.trim()) {
      throw new Error("retrieve_knowledge requires a 'query' parameter to search the knowledge base.");
    }
    if (!context.grounding) {
      return {
        output: "Knowledge base (RAG) is not initialized or configured in this environment.",
        summary: "Knowledge base not available",
      };
    }

    const res = await context.grounding.prepare({ runId: context.runId, text: query });
    const chunks = res.chunks ?? [];
    if (chunks.length === 0) {
      return {
        output: `No matching standard operating procedure clauses found for query: "${query}".`,
        summary: `Retrieved 0 matching clauses for "${query}"`,
      };
    }

    const formattedChunks = chunks.map((c, i) =>
      `[CITATION: ${c.chunkId}] (Document: ${c.docId}, §${c.sectionLabel}, Page ${c.page}):\n${c.text}`
    ).join("\n\n---\n\n");

    return {
      output: formattedChunks,
      summary: `Retrieved ${chunks.length} clauses for "${query}" (top: ${chunks[0].docId} §${chunks[0].sectionLabel})`,
    };
  },
};

/**
 * 5. execute_python: Sandboxed Python runner with network isolation.
 */
export const executePythonTool: AgentTool = {
  name: "execute_python",
  definition: {
    type: "function",
    function: {
      name: "execute_python",
      description: "Execute Python in run storage. OS isolation is probed first. Without OS isolation, explicit approval is required and filesystem and network limits are not enforced. Standard library only (no docx/openpyxl). For Word (.docx) or Excel (.xlsx) deliverables, use 'generate_deliverable' instead. Captures stdout, stderr, exit code, and created files.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", format: "multiline", description: "The complete Python source code to execute." },
          input_files: {
            type: "array",
            items: { type: "string" },
            description: "Filenames from run input directory to stage into sandbox.",
          },
          filename: { type: "string", description: "Name of the script file. Defaults to 'task.py'." },
          validation_code: { type: "string", format: "multiline", description: "Optional separate Python assertions, run after the repaired script succeeds. Public source functions are available by name or through repaired['function']. Invoke assertions; uncalled test definitions do not validate behavior. Input files are available by filename. Derive expectations from the request and original evidence. Checks are not included in the exported source." },
          checks: { type: "array", description: "Structured behavior checks avoid Python quoting and import errors. Call a public source function with JSON arguments and compare its return with expected. Derive expectations independently from original source, request and input evidence.", items: { type: "object", properties: {
            function: { type: "string" }, args: { type: "array", items: {} }, kwargs: { type: "object" }, expected: {},
          }, required: ["function", "args", "expected"] } },
        },
        required: ["code"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    let validationCode = typeof args.validation_code === "string" ? args.validation_code : "";
    const validationChecksIgnored: string[] = [];
    // A generated assertion is not a specification. Only checks supplied
    // verbatim by the user or original evidence can reject an attached repair.
    const attachedRepair = context.runContract?.routing?.intentType === "code_modification" && !context.runContract.workspace?.requested;
    const originalEvidence = [context.originalUserRequest, context.sourceReviewEvidence].filter(Boolean).join("\n");
    const normalizeCheck = (value: string) => value.replace(/\s+/g, " ").trim();
    const groundedCheck = (value: string) => Boolean(value.trim()) && normalizeCheck(originalEvidence).includes(normalizeCheck(value));
    if (attachedRepair && validationCode.trim() && !groundedCheck(validationCode)) {
      validationChecksIgnored.push("Model-supplied validation code was not present in the original request or source. It was not executed and cannot direct a repair.");
      validationCode = "";
    }
    const useStructuredChecks = args.checks !== undefined && (!attachedRepair || groundedCheck(JSON.stringify(args.checks)));
    if (attachedRepair && args.checks !== undefined && !useStructuredChecks) {
      validationChecksIgnored.push("Model-supplied expected values were not present in the original request or source. These checks were not executed and cannot direct a repair.");
    }
    if (useStructuredChecks) {
      if (!Array.isArray(args.checks) || !args.checks.length || args.checks.some(check => !check || typeof check.function !== "string" || !Array.isArray(check.args) || !Object.prototype.hasOwnProperty.call(check, "expected") || (check.kwargs !== undefined && (!check.kwargs || typeof check.kwargs !== "object" || Array.isArray(check.kwargs))))) {
        throw { code: "invalid_arguments", retryable: true, message: "checks must contain a function name, args array, expected value and optional kwargs object." };
      }
      validationCode += `\nimport json as _workbench_json\nfor _workbench_check in _workbench_json.loads(${JSON.stringify(JSON.stringify(args.checks))}):\n    _workbench_function = repaired[_workbench_check['function']]\n    _workbench_actual = _workbench_function(*_workbench_check['args'], **_workbench_check.get('kwargs', {}))\n    assert _workbench_actual == _workbench_check['expected'], repr({'function': _workbench_check['function'], 'actual': _workbench_actual, 'expected': _workbench_check['expected']})\n`;
    }
    let code = extractContentArg(args) || String(args.code ?? args.script ?? args.python_code ?? args.source ?? "");
    let sourceFile: string | undefined;
    if (args.source_file !== undefined || args.edits !== undefined) {
      const source = String(args.source_file ?? "");
      const validationRetry = args.source_revision !== undefined && Array.isArray(args.edits) && args.edits.length === 0 && Boolean(validationCode.trim());
      if (!source || source !== path.basename(source) || (args.edits !== undefined && (!Array.isArray(args.edits) || (!args.edits.length && !validationRetry))) || (args.edits === undefined && !code.trim())) {
        throw { code: "invalid_arguments", retryable: true, message: "Source repair requires an attached source and code or exact edits. To retry checks without changing source, supply its returned source_revision, edits=[] and validation_code." };
      }
      sourceFile = source;
      const inputDirectory = resolveRunPath(context.runId, "input", "input");
      const entry = readdirSync(inputDirectory).find(filename => filename === source || filename.endsWith(`-${source}`));
      if (!entry) throw { code: "file_not_found", retryable: true, message: `Attached source not found: ${source}` };
      if (args.edits !== undefined) code = readFileSync(resolveRunPath(context.runId, `input/${entry}`, "input"), "utf8");
      if (args.source_revision !== undefined && args.edits !== undefined) {
        const revision = String(args.source_revision);
        if (!/^[a-f0-9]{64}$/.test(revision)) throw { code: "invalid_arguments", retryable: true, message: "source_revision must be a returned SHA-256 revision." };
        const sourceKey = createHash("sha256").update(source).digest("hex");
        const revisionPath = resolveRunPath(context.runId, `intermediate/repair-sources/${sourceKey}/${revision}.py`, "intermediate");
        if (!existsSync(revisionPath)) throw { code: "file_not_found", retryable: true, message: "Source revision does not exist for this attachment in this run." };
        code = readFileSync(revisionPath, "utf8");
        if (createHash("sha256").update(code).digest("hex") !== revision) throw new Error("Repair source revision integrity failure");
      }
      for (const edit of (args.edits as Array<{ old: string; new: string }> | undefined) ?? []) {
        if (!edit || typeof edit.old !== "string" || !edit.old || typeof edit.new !== "string" || code.split(edit.old).length !== 2) {
          throw { code: "invalid_arguments", retryable: true, message: "Each edit must supply old/new strings, with old matching exactly once in the selected source. Omit source_revision for the original attachment, or use the revision returned by a previous execution. Anchor insertions to an existing line; empty old is not allowed." };
        }
        const offset = code.indexOf(edit.old);
        const lineStart = code.lastIndexOf("\n", offset - 1) + 1;
        const prefix = code.slice(lineStart, offset);
        let replacement = edit.new;
        // Exact replacement is the default. Relative indentation is opt-in;
        // inferring it from source text can silently double an absolute indent.
        if (args.edit_indentation === "relative" && /^[ \t]*$/.test(prefix) && !/^[ \t]/.test(edit.old)) {
          const lines = replacement.split("\n");
          const nonempty = lines.filter((line: string) => line.trim());
          const common = nonempty.length ? Math.min(...nonempty.map((line: string) => line.match(/^[ \t]*/)?.[0].length ?? 0)) : 0;
          replacement = lines.map((line: string) => line.slice(common)).join(`\n${prefix}`);
        }
        code = code.replace(edit.old, () => replacement);
      }
    }
    // JSON transport has already decoded strings. Keep executable source exact;
    // a second escape decode or a speculative syntax rewrite changes behavior.
    if (!code.trim()) {
      throw new Error("execute_python requires 'code' (or 'script') containing Python source code to execute.");
    }
    const filename = String(args.filename ?? args.path ?? args.file ?? "task.py");
    const rawInputs=Array.isArray(args.input_files)?args.input_files:[args.input_files,args.input_file,args.data_file].filter(value=>typeof value==="string").flatMap(value=>String(value).split(","));
    if ([filename,...rawInputs.map(String)].some(value=>path.isAbsolute(value)||value.split(/[\\/]/).includes("..")))throw {code:"permission_denied",message:"Python paths must stay within run storage.",retryable:false};
    let inputFiles: string[] = [];
    if (Array.isArray(args.input_files)) {
      inputFiles = args.input_files.map((f) => path.basename(String(f).trim())).filter(Boolean);
    } else if (typeof args.input_files === "string" && args.input_files.trim()) {
      inputFiles = args.input_files.split(",").map((f) => path.basename(f.trim())).filter(Boolean);
    } else if (typeof args.input_file === "string" && args.input_file.trim()) {
      inputFiles = [path.basename(args.input_file.trim())];
    } else if (typeof args.data_file === "string" && args.data_file.trim()) {
      inputFiles = [path.basename(args.data_file.trim())];
    }

    // Explicit input_files define the command-line interface. Discover only when
    // omitted; source attachments are not extra arguments to the repaired program.
    const hasExplicitInputs = args.input_files !== undefined || args.input_file !== undefined || args.data_file !== undefined;
    // Automatically stage run data attachments when input_files is omitted.
    const inputDir = resolveRunPath(context.runId, "input", "input");
    if (existsSync(inputDir)) {
      const entries = readdirSync(inputDir, { withFileTypes: true });
      const cleanFiles = entries
        .filter((e: any) => e.isFile() && !e.name.startsWith("."))
        .map((e: any) => e.name.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, ""));
      for (const f of cleanFiles) {
        if (!hasExplicitInputs && !/\.(?:py|js|ts|sh)$/i.test(f) && !inputFiles.includes(f)) {
          inputFiles.push(f);
        }
      }
    }

    // Prioritize data files (.csv, .tsv, .json, .log, .txt, .dat, .xml, .xlsx) before code files (.py, .js, .ts)
    // so sys.argv[1] is the primary data file target for the script
    const isDataFile = (f: string) => /\.(csv|tsv|json|log|txt|dat|xml|xlsx)$/i.test(f);
    if (!hasExplicitInputs) inputFiles.sort((a, b) => {
      const aData = isDataFile(a);
      const bData = isDataFile(b);
      if (aData && !bData) return -1;
      if (!aData && bData) return 1;
      return 0;
    });

    const intermediateDir = resolveRunPath(context.runId, "intermediate", "intermediate");
    const scriptPath = resolveRunPath(context.runId, `intermediate/${filename}`, "intermediate");
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, code, "utf8");

    // Ensure task.py is present for the python runner
    if (filename !== "task.py") {
      writeFileSync(path.join(intermediateDir, "task.py"), code, "utf8");
    }
    if (filename.includes("-")) {
      const underscored = filename.replace(/-/g, "_");
      writeFileSync(path.join(intermediateDir, underscored), code, "utf8");
    }

    // Link full-source retries to their unique attached source when the persisted
    // operation is an attachment repair. Multiple sources require explicit identity.
    if (!sourceFile && context.runContract?.routing?.intentType === "code_modification" && !context.runContract.workspace.requested) {
      const sources = existsSync(inputDir) ? [...new Set(readdirSync(inputDir).filter(file => /\.py$/i.test(file)).map(file => file.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "")))] : [];
      if (sources.length === 1) sourceFile = sources[0].replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
    }
    const revision = createHash("sha256").update(code).digest("hex");
    if (sourceFile) {
      const sourceKey = createHash("sha256").update(sourceFile).digest("hex");
      const revisionRelative = `repair-sources/${sourceKey}/${revision}.py`;
      const revisionPath = resolveRunPath(context.runId, `intermediate/${revisionRelative}`, "intermediate");
      if (existsSync(revisionPath)) {
        if (readFileSync(revisionPath, "utf8") !== code) throw new Error("Repair source revision integrity failure");
      } else writeRunFile(context.runId, "intermediate", revisionRelative, code);
    }
    const repairSource = sourceFile ? { source_file: sourceFile, source_revision: revision, code,
      nextEdit: "To edit this exact attempted source, use source_file and source_revision above with old strings from this code. Omitting source_revision selects the original attachment." } : undefined;
    const sharedReviewInput={runId:context.runId,emitProgress:context.emitRunEvent,isCancelled:context.isCancelled,gateway:context.gateway,modelId:context.runContract?.routing?.driverModel??"primary-model",request:context.originalUserRequest??"Repair the attached source",sourceEvidence:context.sourceReviewEvidence??"",sourceChecklist:context.sourceReviewChecklist};
    if(attachedRepair && context.envelope?.mode==="work"){
      const gaps=await reviewProposedPython({...sharedReviewInput,proposedSource:code});
      assertRuntimeActive();
      if(gaps.length)return {ok:false,output:JSON.stringify({repairSource,gaps}),summary:"Source review found defects before execution",error:{code:"validation_failure",retryable:true,message:JSON.stringify(gaps)}};
    }
    const returnValidationName = `check-returns-${randomUUID()}.py`;
    writeRunFile(context.runId, "intermediate", returnValidationName, buildPythonReturnValidationRunner(filename));
    let execResult = await executePython(context.runId, returnValidationName, inputFiles, [], 60000, context.workspaceRoot);
    let failureStage = "source_execution";
    let validationAssertionsPassed = false;
    if (execResult.exitCode === 0 && !execResult.timedOut && validationCode.trim()) {
      const validationName = `validation-${randomUUID()}.py`;
      const validationSource = buildPythonBehaviorValidationRunner(filename, validationCode);
      writeRunFile(context.runId, "intermediate", validationName, validationSource);
      const validation = await executePython(context.runId, validationName, inputFiles, [], 60000, context.workspaceRoot);
      failureStage = "behavior_checks";
      validationAssertionsPassed = validation.exitCode === 0 && !validation.timedOut;
      execResult = { ...validation, stdout: `${execResult.stdout}\n${validation.stdout}`.trim(), durationMs: execResult.durationMs + validation.durationMs,
        inputEvidence: [...(execResult.inputEvidence??[]),...(validation.inputEvidence??[])],
        outputFiles: [...new Set([...execResult.outputFiles, ...validation.outputFiles])],
        capturedOutput: { stdout: `${execResult.capturedOutput?.stdout ?? execResult.stdout}\n${validation.capturedOutput?.stdout ?? validation.stdout}`.trim(), stderr: `${execResult.capturedOutput?.stderr ?? execResult.stderr}\n${validation.capturedOutput?.stderr ?? validation.stderr}`.trim(), truncated: Boolean(execResult.capturedOutput?.truncated || validation.capturedOutput?.truncated) },
      };
    }
    const summary = `Executed Python (${filename}): exit ${execResult.exitCode} in ${execResult.durationMs}ms`;
    const intermediate: ToolExecutionResult["intermediate"] = {
      type: "execution", status: execResult.exitCode === 0 && !execResult.timedOut && !execResult.capturedOutput?.truncated ? "complete" : "partial", origin: "execution",
      payload: { ...execResult, ...(repairSource ? { repairSource } : {}), validationAssertionsPassed, validationChecksIgnored, ...(execResult.exitCode !== 0 ? { failureStage } : {}) }, sources: inputFiles.map((file) => ({ filename: file, relation: "input" })),
    };
    const { capturedOutput: _capturedOutput, ...observation } = execResult;

    if (execResult.exitCode !== 0 || execResult.timedOut) {
      return { ok: false, output: JSON.stringify({ repairSource, ...observation, failureStage,
        recovery: failureStage === "behavior_checks" ? "The source command completed. Check the assertion syntax, invocation and expected behavior against original evidence. To change only checks, use the returned source_revision, edits=[] and validation_code. Change source only when the checks establish a source defect." : "Repair the observed source failure; continue from the returned source_revision when editing this attempt." }, null, 2), summary, intermediate,
        error: { code: execResult.timedOut ? "timeout" : "validation_failure", retryable: true,
          message: execResult.stderr || `Python execution failed with exit ${execResult.exitCode}` } };
    }

    const artifacts: ArtifactRef[] = [];
    const outputDir = resolveRunPath(context.runId, "output", "output");

    // Collect any output files created during execution
    for (const outFile of execResult.outputFiles) {
      if (context.runContract && !matchesContractDeliverable(context.runContract, outFile)) continue;
      const outPath = path.join(outputDir, outFile);
      if (existsSync(outPath)) {
        try {
          const stat = statSync(outPath);
          if(context.envelope?.mode==="work"){
            const parsed=await parseFileIndependently(resolveSafe(outputDir,outFile),path.extname(outFile).slice(1),context.signal);
            if(parsed.formulas)throw new Error("Work v1 supports XLSX tables without formula cells.");
          }
          artifacts.push({
            artifactId: randomUUID(),
            runId: context.runId,
            kind: inferArtifactKind(outFile),
            filename: outFile,
            relativePath: `runs/${context.runId}/output/${outFile}`,
            sizeBytes: stat.size,
            createdAt: new Date().toISOString(),
          });
        } catch(error) {assertRuntimeActive();if(context.envelope?.mode==="work")throw error;}
      }
    }

    // Also persist the executed/repaired script itself as an artifact
    if (!context.runContract || context.runContract.deliverables.some((d) => d.filename?.endsWith(".py"))) try {
      const scriptBase = path.basename(filename);
      // If the filename was generic (task.py or run_fixed_script.py), check if run attachments have a source python script
      let targetName = scriptBase;
      if (scriptBase === "task.py" || scriptBase.startsWith("run_")) {
        const inDir = resolveRunPath(context.runId, "input", "input");
        if (existsSync(inDir)) {
          const pyEntry = readdirSync(inDir).find((f) => f.endsWith(".py") && !f.startsWith("."));
          if (pyEntry) {
            const cleanName = pyEntry.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
            targetName = cleanName.replace(/^(?:broken|buggy)-/i, "fixed-");
          }
        }
      }
      const requestedScript = context.requestedArtifacts?.filter((item) => item.type === "file" && item.filename.endsWith(".py"));
      const contractScripts = context.runContract?.deliverables.filter((item) => item.type === "file" && item.filename?.endsWith(".py"));
      const artifactScriptFilename = requestedScript?.length === 1 ? requestedScript[0].filename :
        contractScripts?.length === 1 && contractScripts[0].filename ? contractScripts[0].filename :
        targetName.startsWith("repaired-") || targetName.startsWith("fixed-")
          ? targetName
          : `repaired-${targetName}`;
      const scriptOutPath = resolveRunPath(context.runId, `output/${artifactScriptFilename}`, "output");
      mkdirSync(path.dirname(scriptOutPath), { recursive: true });
      writeFileSync(scriptOutPath, code, "utf8");
      artifacts.push({
        artifactId: randomUUID(),
        runId: context.runId,
        kind: "txt",
        filename: artifactScriptFilename,
        relativePath: `runs/${context.runId}/output/${artifactScriptFilename}`,
        sizeBytes: Buffer.byteLength(code, "utf8"),
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      throw new Error(`Repaired source export failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const hasDocDeliverables =
      context.runContract?.deliverables.some((d) => d.type === "docx" || d.type === "xlsx" || d.type === "md") ||
      context.requestedArtifacts?.some((a) => a.filename?.endsWith(".docx") || a.filename?.endsWith(".xlsx") || a.filename?.endsWith(".md"));

    const deliveryStatus = hasDocDeliverables
      ? "Calculations completed successfully. Proceed immediately to invoke 'generate_deliverable' to generate the requested document using the computed figures."
      : "The executed source is already exported and ran successfully against the supplied inputs. Report the observed output and any limits; do not create another export or helper script.";

    // Work reviews saved source and immutable execution evidence in its separate
    // verification stage. A reviewer retry must not execute this tool again.
    const behaviorReview=attachedRepair&&context.envelope?.mode==="work"
      ? {status:"unverified",reason:"Post-execution behavior review is pending."}:undefined;
    return {
      output: JSON.stringify({
        ...observation,
        behaviorReview,
        sourceDigest:revision,
        artifacts: artifacts.map((artifact) => ({ filename: artifact.filename, relativePath: artifact.relativePath })),
        executionPassed: execResult.exitCode === 0 && !execResult.timedOut,
        validationAssertionsPassed,
        validationChecksIgnored,
        deliveryStatus,
      }, null, 2),
      summary,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      sideEffects: [`executed:${filename}`],
      intermediate:intermediate?{...intermediate,payload:{...(intermediate.payload as Record<string,unknown>),...(behaviorReview?{behaviorReview}:{}),sourceDigest:revision}}:undefined,
    };
  },
};

/**
 * 6. generate_deliverable: Builds publication-grade .docx, .xlsx, or .md file.
 */
export const generateDeliverableTool: AgentTool = {
  name: "generate_deliverable",
  definition: {
    type: "function",
    function: {
      name: "generate_deliverable",
      description:
        "Generate a requested downloadable file in the run output folder: Word (.docx), Excel (.xlsx), Markdown (.md) or source/text file. Word supports general drafting; tables are optional. Compiles .docx and .xlsx automatically without Python packages. Use type='file' for repaired code. Use ONLY for requested deliverables.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["docx", "xlsx", "csv", "json", "txt", "md", "file"],
            description: "'docx' for Word, 'xlsx' for Excel, 'md' for Markdown, 'file' for exact source/text content and filename.",
          },
          title: {
            type: "string",
            description: "Formal title of the deliverable document.",
          },
          content: {
            type: "string",
            format: "multiline",
            description:
              "Complete Markdown document body, including any requested tables as Markdown, or exact source/text content for type='file'. Do not pass outlines or placeholder text.",
          },
          filename: {
            type: "string",
            description: "Desired deliverable filename (e.g. 'approval-note.docx', 'findings.md', 'summary.xlsx').",
          },
        },
        required: ["type"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    let effectiveArgs = args;
    if (typeof args.raw === "string" && args.raw.trim().startsWith("{")) {
      try {
        effectiveArgs = { ...args, ...JSON.parse(args.raw) };
      } catch {}
    }
    for (const wrapper of ["parameters", "arguments", "input", "params"]) {
      const val = effectiveArgs[wrapper];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        effectiveArgs = { ...effectiveArgs, ...(val as Record<string, unknown>) };
      }
    }
    let type = String(effectiveArgs.type ?? effectiveArgs.kind ?? effectiveArgs.format ?? "").toLowerCase();
    let title = String(effectiveArgs.title ?? effectiveArgs.name ?? effectiveArgs.heading ?? "Deliverable");
    let content = extractContentArg(effectiveArgs) || String(effectiveArgs.content ?? effectiveArgs.body ?? effectiveArgs.text ?? effectiveArgs.markdown ?? "");
    if (context.runContract && context.runContract.deliverables.length === 0) {
      throw { code: "permission_denied", retryable: false, message: "This file export is not part of the user's run contract. Workspace edits do not authorize a new downloadable document." };
    }
    if (effectiveArgs.report_rows === null || (Array.isArray(effectiveArgs.report_rows) && effectiveArgs.report_rows.length === 0)) {
      // Older calls may still include this optional field. Empty rows do not
      // request a report table, even when the draft uses attached sources.
      effectiveArgs = { ...effectiveArgs }; delete effectiveArgs.report_rows;
    }
    // Support existing structured-report calls without exposing this specialized
    // field in the general drafting schema. Supplied rows still require evidence.
    if(effectiveArgs.report_rows!==undefined){
      const columns=['source','equipment','measurements','defects','inspector_notes','decision','citations'] as const;
      const rows=z.array(z.object({source:z.string().min(1),equipment:z.string().optional(),measurements:z.string().optional(),defects:z.string().optional(),inspector_notes:z.string().optional(),decision:z.string().optional(),citations:z.string().optional()}).strict()).min(1).max(500).safeParse(effectiveArgs.report_rows);
      if(!rows.success)throw {code:'invalid_arguments',retryable:true,message:'report_rows requires at least one row with a non-empty source. Omit report_rows when no sourced table is requested. A sourced table must cover all supplied source pages.'};
      const missing=(context.sourceReferences??[]).filter(reference=>!rows.data.some(row=>row.source.includes(`${reference.filename}, page ${reference.page}`)));
      if(missing.length)throw {code:'invalid_arguments',retryable:true,message:'Report rows omit supplied source pages: '+missing.map(reference=>`${reference.filename}, page ${reference.page}`).join('; ')};
      const cell=(value:string)=>value.replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
      content=[content,`| ${columns.join(' | ')} |`,`| ${columns.map(()=>'---').join(' | ')} |`,...rows.data.map(row=>`| ${columns.map(column=>cell(row[column]??'')).join(' | ')} |`)].filter(Boolean).join('\n');
    }
    const rawFilename = String(effectiveArgs.filename ?? effectiveArgs.path ?? effectiveArgs.file ?? "");
    if (rawFilename && (path.isAbsolute(rawFilename) || rawFilename.includes("\\") || rawFilename.split("/").some(part=>part===".." || part==="."))) throw {code:"permission_denied",message:"Deliverables require a contained relative filename.",retryable:false};
    let filename = rawFilename;

    // 1. Align with contract deliverables if present
    const contractDeliverables = context.runContract?.deliverables ?? [];
    if (contractDeliverables.length > 0) {
      const matchingContractD = contractDeliverables.find((d) =>
        filename && d.filename && (
          path.basename(filename).toLowerCase() === path.basename(d.filename).toLowerCase() ||
          path.basename(filename, path.extname(filename)).toLowerCase() === path.basename(d.filename, path.extname(d.filename)).toLowerCase()
        )
      ) || (!rawFilename && contractDeliverables.length === 1 ? contractDeliverables[0] : undefined);

      if (matchingContractD) {
        if (!rawFilename || (matchingContractD.filename && path.basename(filename, path.extname(filename)).toLowerCase() === path.basename(matchingContractD.filename, path.extname(matchingContractD.filename)).toLowerCase())) {
          filename = matchingContractD.filename ?? filename;
        }
        if (matchingContractD.filename?.endsWith(".docx") || matchingContractD.type === "docx") {
          type = "docx";
        } else if (matchingContractD.filename?.endsWith(".xlsx") || matchingContractD.type === "xlsx") {
          type = "xlsx";
        } else if (matchingContractD.type && !type) {
          type = matchingContractD.type;
        }
      }
    }

    if (type !== "file" && content.includes("\\n") && !content.includes("\n")) {
      content = content.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
    }
    if (!type) {
      type = filename.endsWith(".docx") ? "docx" : filename.endsWith(".xlsx") ? "xlsx" : "md";
    }
    if (!["docx", "xlsx", "csv", "json", "txt", "md", "file"].includes(type)) {
      throw { code: "invalid_arguments", retryable: true, message: `Unsupported deliverable type ${type}. Use docx, xlsx, csv, json, txt, md or file.` };
    }
    if (!filename) {
      filename = `deliverable.${type}`;
    }
    if (type !== "file" && !filename.endsWith(`.${type}`)) {
      filename = filename.replace(/\.[^.]+$/, "") + `.${type}`;
    }

    if (context.runContract && contractDeliverables.length > 0 && !matchesContractDeliverable(context.runContract, filename, type)) {
      throw { code: "invalid_arguments", retryable: true, message: `The persisted run contract does not request this deliverable: ${filename}.` };
    }
    if (context.requestedArtifacts?.length && !context.requestedArtifacts.some((artifact) => artifact.filename === filename)) {
      const stemMatch = context.requestedArtifacts.find((artifact) =>
        path.basename(artifact.filename, path.extname(artifact.filename)).toLowerCase() === path.basename(filename, path.extname(filename)).toLowerCase()
      );
      if (!rawFilename && context.requestedArtifacts.length === 1 && context.requestedArtifacts[0].filename) {
        filename = context.requestedArtifacts[0].filename;
        if (filename.endsWith(".docx")) type = "docx";
        else if (filename.endsWith(".xlsx")) type = "xlsx";
      } else if (stemMatch && stemMatch.filename) {
        filename = stemMatch.filename;
        if (filename.endsWith(".docx")) type = "docx";
        else if (filename.endsWith(".xlsx")) type = "xlsx";
      } else {
        throw { code: "invalid_arguments", retryable: true,
          message: `Use the requested deliverable type and filename: ${context.requestedArtifacts.map((artifact) => artifact.filename).join(", ")}. Received ${filename}.` };
      }
    }

    if (["file","csv","json","txt"].includes(type)) {
      if (!content.trim() || !args.filename) throw { code: "invalid_arguments", retryable: true, message: "Source file deliverables require filename and complete nonempty content." };
      const relativePath = writeRunFile(context.runId, "output", filename, content, true);
      const kind=inferArtifactKind(filename);
      const check=await verifyArtifactFile(absoluteDataPath(relativePath),{runId:context.runId,expectedKind:kind,originalContent:content});
      if(!check.valid)throw new Error(`Saved output is invalid: ${check.details.error}`);
      if(context.envelope?.mode==="work")await parseFileIndependently(absoluteDataPath(relativePath),path.extname(filename).slice(1),context.signal);
      const artifact = artifactRef(context.runId, kind, filename, relativePath);
      return { output: `Created downloadable file ${filename} (${artifact.sizeBytes} bytes).`, summary: `Created deliverable: ${filename}`, artifacts: [artifact], sideEffects: [`artifact:${filename}`] };
    }

    // Clean placeholder markers if present
    content = content
      .replace(/\[\/?(?:TOOL_RESULT|END_TOOL_RESULT|TOOL_CALL|END_TOOL_CALL)\]/gi, "")
      .trim();

    // Guardrail against placeholder or empty content
    const isPlaceholderOnly =
      !content ||
      /^(?:pending|n\/a|none|placeholder|todo)$/i.test(content) ||
      /\[tool_result\]/i.test(content);

    if (isPlaceholderOnly) {
      if (
        context.lastAssistantContent &&
        context.lastAssistantContent.length > 150 &&
        (/#+\s+/m.test(context.lastAssistantContent) || /\|[^\n]+\|[^\n]+\|/m.test(context.lastAssistantContent))
      ) {
        content = context.lastAssistantContent;
      } else {
        let candidateFromStore = "";
        if (context.resultStore) {
          const results = context.resultStore.listResults();
          for (const r of results) {
            if (r.type === "execution") {
              const slice = context.resultStore.retrieveResultSlice(r.resultId);
              if (slice.content && slice.content.length > 50) {
                candidateFromStore = `# Execution observations\n\n${slice.content}`;
                break;
              }
            }
          }
        }
        if (candidateFromStore) {
          content = candidateFromStore;
        } else {
          throw new Error(
            `Cannot generate deliverable "${filename}" with placeholder or empty content. ` +
            `You must first inspect input files (using read_file or extract_document), synthesize the findings, ` +
            `and call generate_deliverable with complete, comprehensive, publication-ready markdown or text content.`
          );
        }
      }
    }

    // Keep provenance from actual document extraction in the exported artifact,
    // even when the model mentions the source only in its chat response.
    const citations = (context.sourceReferences ?? []).map((source) => `${source.filename}, page ${source.page}`);
    if (citations.length > 0) content += `\n\n## Source documents\n${citations.map((citation) => `- ${citation}`).join("\n")}`;

    // If content contains template placeholder text ("Markdown table with columns" or "[insert table]"), enrich or reject
    const placeholderTableRegex = /(?:markdown\s+)?table\s+(?:with|of)\s+columns|\[(?:insert\s+)?(?:table|findings|measurements)[^\]]*\]|\((?:insert\s+)?(?:table|findings|measurements)[^)]*\)/i;
    if (
      placeholderTableRegex.test(content) &&
      !/\|[^\n]+\|[^\n]+\|\r?\n\s*\|?[-:\s|]+\|\r?\n\s*\|?[^\n]+\|[^\n]+\|/.test(content)
    ) {
      const realTableMatch = context.lastAssistantContent?.match(
        /(?:^|\n)\s*(\|?[^\n]+\|\r?\n\s*\|?[-:\s|]+\|\r?\n(?:\s*\|?[^\n]+\|\r?\n?)+)/m
      );
      if (realTableMatch && realTableMatch[1]) {
        const extractedTable = realTableMatch[1].trim();
        content = content.replace(new RegExp(`.*(?:${placeholderTableRegex.source}).*`, "i"), extractedTable);
      } else if (
        context.lastAssistantContent &&
        context.lastAssistantContent.length > 200 &&
        /#+\s+/m.test(context.lastAssistantContent) &&
        /\|[^\n]+\|[^\n]+\|/m.test(context.lastAssistantContent)
      ) {
        content = context.lastAssistantContent;
      } else {
        throw new Error(
          `Cannot generate deliverable "${filename}" with template placeholder text. ` +
          `You must provide the complete document content with actual measured values and completed Markdown table rows.`
        );
      }
    }

    // If content still lacks a multi-row markdown table, check if the assistant generated one in this turn
    const hasTableInContent = /\|[^\n]+\|[^\n]+\|\r?\n\s*\|?[-:\s|]+\|\r?\n\s*\|?[^\n]+\|[^\n]+\|/m.test(content);
    if (!hasTableInContent && context.lastAssistantContent) {
      const realTableMatch = context.lastAssistantContent.match(
        /(?:^|\n)\s*(\|?[^\n]+\|\r?\n\s*\|?[-:\s|]+\|\r?\n(?:\s*\|?[^\n]+\|\r?\n?)+)/m
      );
      if (realTableMatch && realTableMatch[1]) {
        const extractedTable = realTableMatch[1].trim();
        const placeholderRegex = /(\[insert (?:table|findings|measurements)[^\]]*\]|\(insert (?:table|findings|measurements)[^)]*\)|\[table (?:with|of)[^\]]*\]|\[findings table\])/i;
        if (placeholderRegex.test(content)) {
          content = content.replace(placeholderRegex, extractedTable);
        } else {
          // If there is a Findings or Measurements section header, insert the table right below it
          const findingsHeaderMatch = content.match(/(#{1,3}\s+(?:\d+\.\s+)?(?:Findings|Measurements|Inspection Results)[^\n]*\n)/i);
          if (findingsHeaderMatch && findingsHeaderMatch.index !== undefined) {
            const insertPos = findingsHeaderMatch.index + findingsHeaderMatch[0].length;
            content = `${content.slice(0, insertPos)}\n${extractedTable}\n\n${content.slice(insertPos)}`;
          }
        }
      }
    }

    // If title is default "Deliverable", extract title from the first heading if present
    if (title === "Deliverable") {
      const headingMatch = content.match(/^#+\s+([^\n]+)/m);
      if (headingMatch) {
        title = headingMatch[1].trim();
      }
    }

    const artifacts: ArtifactRef[] = [];

    if (type === "docx") {
      const art = await generateDocx(context.runId, { title, body: content, sections: [] }, filename);
      artifacts.push(art);
    } else if (type === "xlsx") {
      if (!content.trim()) throw new Error("Spreadsheet export requires complete source-derived content.");
      const art = await generateXlsxFromContent(context.runId, content, filename, title);
      artifacts.push(art);
    } else {
      createRunDirectories(context.runId);
      const intermediateDir = resolveRunPath(context.runId, "intermediate", "intermediate");
      const tempName = `staging-${randomUUID()}-${filename}`;
      const tempPath = path.join(intermediateDir, tempName);
      mkdirSync(intermediateDir, { recursive: true });
      writeFileSync(tempPath, content, "utf8");

      const verification = await verifyArtifactFile(tempPath, {
        runId: context.runId,
        expectedKind: "md",
        originalContent: content,
      });

      if (!verification.valid) {
        try { rmSync(tempPath, { force: true }); } catch {}
        throw new Error(`Artifact verification failed for Markdown deliverable "${filename}": ${verification.details.error}`);
      }

      const outDir = resolveRunPath(context.runId, "output", "output");
      const outPath = path.join(outDir, filename);
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, content, "utf8");
      try { rmSync(tempPath, { force: true }); } catch {}

      artifacts.push({
        artifactId: randomUUID(),
        runId: context.runId,
        kind: "md",
        filename,
        relativePath: `runs/${context.runId}/output/${filename}`,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        createdAt: new Date().toISOString(),
        verified: true,
        verificationDetails: verification.details,
      });
    }

    if(context.envelope?.mode==="work")for(const artifact of artifacts){
      const parsed=await parseFileIndependently(absoluteDataPath(artifact.relativePath),path.extname(artifact.filename).slice(1),context.signal);
      if(parsed.formulas)throw new Error("Work v1 supports XLSX tables only; formulas are unavailable.");
    }
    const primaryArt = artifacts[0];
    const checkSummary = primaryArt?.verified
      ? `File passed all structural verification checks (${type.toUpperCase()} package validated)`
      : `File written (${primaryArt?.sizeBytes ?? 0} bytes)`;

    return {
      output: `Deliverable "${filename}" (${primaryArt?.sizeBytes ?? 0} bytes) generated and verified. ${checkSummary}. Saved to disk at ${primaryArt?.relativePath || filename}. Deliverable creation is complete.`,
      summary: `Created deliverable: ${filename}`,
      ...(["docx", "md"].includes(type) ? { data: { responseText: `${content}\n\nSaved: ${filename}.` } } : {}),
      artifacts,
      sideEffects: [`artifact:${filename}`],
    };
  },
};

/** Adds runtime observation without changing requests or tool result contracts. */
function observeGeneration(tool: AgentTool, stage: "repair_generation" | "draft_generation"): AgentTool {
  return { ...tool, execute: (args, context) => withTaskProgress({
    runId: context.runId, emitProgress: context.emitRunEvent, isCancelled: context.isCancelled,
    target: typeof args.filename === "string" ? args.filename : undefined, parentCallId: context.currentCallId,
  }, stage, async activity => {
    const result = await tool.execute(args, context);
    if (result.ok === false) activity.block(result.error?.message ?? "The generation did not finish.");
    return result;
  }) };
}

export const specialistTools: AgentTool[] = [
  extractDocumentTool,
  generateCodeTool,
  generateTextTool,
  retrieveKnowledgeTool,
  executePythonTool,
  generateDeliverableTool,
];
