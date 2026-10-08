import { randomUUID } from "node:crypto";
import { matchesContractDeliverable } from "../run/contract.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { requestBase } from "../gateway/model-gateway.js";
import { executePython } from "./python.js";
import { generateDocx, generateXlsx, generateXlsxFromContent, verifyArtifactFile } from "./artifacts.js";
import { resolveRunPath, writeRunFile, artifactRef } from "../run/filesystem.js";
import { extractContentArg, extractPathArg, findFileInRunDirectories } from "./workspace-tools.js";
import type {
  ArtifactKind,
  ArtifactRef,
  CodeModelRequest,
  DraftModelRequest,
  ModelId,
  PythonExecutionResult,
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
      description: "Extract text, measurements, handwritten annotations, and visual findings from an attached PDF, image, or engineering drawing.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "The filename of the attached document or image to inspect." },
          query: { type: "string", description: "Specific extraction instruction or focus area (e.g. 'extract all tube wall thickness readings and handwritten notes')." },
        },
        required: ["filename"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const rawPath = extractPathArg(args) || String(args.filename ?? args.path ?? args.document ?? args.file ?? "");
    const cleanRawPath = rawPath.trim().replace(/^['"]|['"]$/g, "");
    if (!cleanRawPath) {
      throw new Error(`extract_document requires a filename or path parameter. Received: ${JSON.stringify(args)}`);
    }
    const query = String(args.query ?? args.prompt ?? args.instruction ?? args.focus ?? args.task ?? "Extract all findings, measurements, and annotations from this document.");

    let filePath: string | null = null;
    if (context.workspaceRoot) {
      try {
        const resolved = path.resolve(context.workspaceRoot, cleanRawPath);
        if (existsSync(resolved)) filePath = resolved;
      } catch {}
    }
    if (!filePath && context.runId) {
      filePath = findFileInRunDirectories(context.runId, cleanRawPath);
    }
    if (!filePath && existsSync(cleanRawPath)) {
      filePath = cleanRawPath;
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

    const targetModelId = (context.gateway?.registry?.has("vision-qwen25vl")
      ? "vision-qwen25vl"
      : context.runContract?.routing.driverModel ?? "vision-qwen25vl") as ModelId;

    const base = requestBase(
      context.runId,
      "vision",
      targetModelId,
      "vision-result",
      "You are a specialized multimodal engineering document inspector. Extract all text, tabular readings, handwritten notes, and component identifiers accurately.",
      query,
      60000,
      4096,
      0.1,
    );

    const req: VisionModelRequest = {
      ...base,
      requestId: randomUUID(),
      taskType: "vision",
      modelId: targetModelId as "vision-qwen25vl",
      responseFormat: "vision-result",
      attachment: {
        attachmentId: randomUUID(),
        filename,
        mediaType,
        sizeBytes: 0,
        relativePath: `runs/${context.runId}/input/${filename}`,
      },
      inputMode: "typed-scan",
      parentToolCallId: context.currentCallId,
    };

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
export const generateCodeTool: AgentTool = {
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
    const targetModelId = (context.gateway?.registry?.has("code-qwen25coder")
      ? "code-qwen25coder"
      : context.runContract?.routing.driverModel ?? "code-qwen25coder") as ModelId;

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
      modelId: targetModelId as "code-qwen25coder",
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
export const generateTextTool: AgentTool = {
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
    const targetModelId = (context.gateway?.registry?.has("draft-qwen3")
      ? "draft-qwen3"
      : context.runContract?.routing.driverModel ?? "draft-qwen3") as ModelId;

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
          query: { type: "string", description: "Search query or standard identifier (e.g. 'SOP-114 tube wall thickness criteria', 'SOP-220 valve rating')." },
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
      description: "Execute Python code inside the secure, air-gapped sandbox without network access. Standard library only (no docx/openpyxl). For Word (.docx) or Excel (.xlsx) deliverables, use 'generate_deliverable' instead. Captures stdout, stderr, exit code, and created files.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The Python source code to execute." },
          input_files: {
            type: "array",
            items: { type: "string" },
            description: "Filenames from run input directory to stage into sandbox.",
          },
          filename: { type: "string", description: "Name of the script file. Defaults to 'task.py'." },
          validation_code: { type: "string", description: "Optional separate Python assertions, run after the repaired script succeeds. The dict 'repaired' contains the exact repaired script's functions (use repaired['function'](...)). Input files are available by filename. Derive assertions from the request and actual source data. Validation code is not included in the downloadable repaired source." },
        },
        required: ["code"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    let code = extractContentArg(args) || String(args.code ?? args.script ?? args.python_code ?? args.source ?? "");
    if (code.includes("\\n") && !code.includes("\n")) {
      code = code
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t");
    }
    // 1. Sanitize malformed f-string format specifiers (e.g. :>15,>10 or :>12,>10 or :>15,0>12 or :>12,0)
    code = code.replace(/:([<>=^]?\d+)[,<>=^][^"'\n}]*(?=[}])/g, ":$1");
    // 2. Safe dictionary lookup for arithmetic / print statements (avoids KeyError crashes on missing keys)
    const helper = `
def _safe_lookup(collection, key, default=0):
    if isinstance(collection, dict):
        if key in collection:
            return collection[key]
        if isinstance(key, str):
            k_clean = key.lower().replace(" ", "").replace("_", "")
            for existing_k, v in collection.items():
                if isinstance(existing_k, str):
                    ex_clean = existing_k.lower().replace(" ", "").replace("_", "")
                    if k_clean in ex_clean or ex_clean in k_clean or ("tax" in k_clean and "tax" in ex_clean):
                        return v
        return default
    try:
        return collection[key]
    except Exception:
        return default
`;
    if (!args.validation_code && !code.includes("def _safe_lookup")) {
      code = `${helper}\n${code.replace(/(\b[a-zA-Z_]\w*)\s*\[\s*([^\n\]]+?)\s*\](?!\s*=(?!=))/g, "_safe_lookup($1, $2)")}`;
    }
    if (!code.trim()) {
      throw new Error("execute_python requires 'code' (or 'script') containing Python source code to execute.");
    }
    const filename = String(args.filename ?? args.path ?? args.file ?? "task.py");
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

    // Automatically stage run attachments if input_files is omitted or incomplete
    const inputDir = resolveRunPath(context.runId, "input", "input");
    if (existsSync(inputDir)) {
      const entries = readdirSync(inputDir, { withFileTypes: true });
      const cleanFiles = entries
        .filter((e: any) => e.isFile() && !e.name.startsWith("."))
        .map((e: any) => e.name.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, ""));
      for (const f of cleanFiles) {
        if (!inputFiles.includes(f)) {
          inputFiles.push(f);
        }
      }
    }

    // Prioritize data files (.csv, .tsv, .json, .log, .txt, .dat, .xml, .xlsx) before code files (.py, .js, .ts)
    // so sys.argv[1] is the primary data file target for the script
    const isDataFile = (f: string) => /\.(csv|tsv|json|log|txt|dat|xml|xlsx)$/i.test(f);
    inputFiles.sort((a, b) => {
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

    let execResult = await executePython(context.runId, filename, inputFiles, [], 60000, context.workspaceRoot);
    if (execResult.exitCode === 0 && !execResult.timedOut && typeof args.validation_code === "string" && args.validation_code.trim()) {
      const validationName = `validation-${randomUUID()}.py`;
      const validationSource = `import pathlib, runpy\nrepaired = runpy.run_path(str(pathlib.Path(__file__).parent / ${JSON.stringify(filename)}), run_name="workbench_validation")\n${args.validation_code}\n`;
      writeRunFile(context.runId, "intermediate", validationName, validationSource);
      const validation = await executePython(context.runId, validationName, inputFiles, [], 60000, context.workspaceRoot);
      execResult = { ...validation, stdout: `${execResult.stdout}\n${validation.stdout}`.trim(), durationMs: execResult.durationMs + validation.durationMs,
        capturedOutput: { stdout: `${execResult.capturedOutput?.stdout ?? execResult.stdout}\n${validation.capturedOutput?.stdout ?? validation.stdout}`.trim(), stderr: `${execResult.capturedOutput?.stderr ?? execResult.stderr}\n${validation.capturedOutput?.stderr ?? validation.stderr}`.trim(), truncated: Boolean(execResult.capturedOutput?.truncated || validation.capturedOutput?.truncated) },
      };
    }
    const summary = `Executed Python (${filename}): exit ${execResult.exitCode} in ${execResult.durationMs}ms`;
    const intermediate: ToolExecutionResult["intermediate"] = {
      type: "execution", status: execResult.exitCode === 0 && !execResult.timedOut && !execResult.capturedOutput?.truncated ? "complete" : "partial", origin: "execution",
      payload: { ...execResult }, sources: inputFiles.map((file) => ({ filename: file, relation: "input" })),
    };
    const { capturedOutput: _capturedOutput, ...observation } = execResult;

    if (execResult.exitCode !== 0 || execResult.timedOut) {
      return { ok: false, output: JSON.stringify(observation, null, 2), summary, intermediate,
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
          artifacts.push({
            artifactId: randomUUID(),
            runId: context.runId,
            kind: inferArtifactKind(outFile),
            filename: outFile,
            relativePath: `runs/${context.runId}/output/${outFile}`,
            sizeBytes: stat.size,
            createdAt: new Date().toISOString(),
          });
        } catch {}
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
      const artifactScriptFilename = requestedScript?.length === 1 ? requestedScript[0].filename :
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
      : "The executed source is already exported. If validation passed, provide the final answer; do not create another export or helper script.";

    return {
      output: JSON.stringify({
        ...observation,
        artifacts: artifacts.map((artifact) => ({ filename: artifact.filename, relativePath: artifact.relativePath })),
        validationPassed: typeof args.validation_code === "string" && Boolean(args.validation_code.trim()),
        deliveryStatus,
      }, null, 2),
      summary,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      sideEffects: [`executed:${filename}`],
      intermediate,
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
        "Generate a requested downloadable file in the run output folder: Word (.docx), Excel (.xlsx), Markdown (.md) or source/text file. Compiles .docx and .xlsx automatically without Python packages. Use type='file' for repaired code. Use ONLY for requested deliverables.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["docx", "xlsx", "md", "file"],
            description: "'docx' for Word, 'xlsx' for Excel, 'md' for Markdown, 'file' for exact source/text content and filename.",
          },
          title: {
            type: "string",
            description: "Formal title of the deliverable document.",
          },
          content: {
            type: "string",
            description:
              "Complete Markdown document body, or exact source/text content for type='file'. Do not pass outlines or placeholder text.",
          },
          filename: {
            type: "string",
            description: "Desired deliverable filename (e.g. 'approval-note.docx', 'findings.md', 'summary.xlsx').",
          },
        },
        required: ["type", "content"],
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
    const rawFilename = String(effectiveArgs.filename ?? effectiveArgs.path ?? effectiveArgs.file ?? "");
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

    if (!type) {
      type = filename.endsWith(".docx") ? "docx" : filename.endsWith(".xlsx") ? "xlsx" : "md";
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

    if (type === "file") {
      if (!content.trim() || !args.filename) throw { code: "invalid_arguments", retryable: true, message: "Source file deliverables require filename and complete nonempty content." };
      const relativePath = writeRunFile(context.runId, "output", filename, content, true);
      const artifact = artifactRef(context.runId, inferArtifactKind(filename), filename, relativePath);
      return { output: `Created downloadable file ${filename} (${artifact.sizeBytes} bytes).`, summary: `Created deliverable: ${filename}`, artifacts: [artifact], sideEffects: [`artifact:${filename}`] };
    }

    // Clean placeholder markers if present
    content = content
      .replace(/\[\/?(?:TOOL_RESULT|END_TOOL_RESULT|TOOL_CALL|END_TOOL_CALL)\]/gi, "")
      .trim();

    // Guardrail against placeholder or empty content
    const isPlaceholderOnly =
      !content ||
      content.length < 15 ||
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
                candidateFromStore = `# Financial Reconciliation Findings\n\n${slice.content}`;
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
      let art: ArtifactRef;
      if (content && content.trim().length > 0) {
        art = await generateXlsxFromContent(context.runId, content, filename, title);
      } else {
        const mockExec: PythonExecutionResult = {
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          outputFiles: [],
          durationMs: 0,
        };
        art = await generateXlsx(context.runId, mockExec, filename);
      }
      artifacts.push(art);
    } else {
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

    const primaryArt = artifacts[0];
    const checkSummary = primaryArt?.verified
      ? `File passed all structural verification checks (${type.toUpperCase()} package validated)`
      : `File written (${primaryArt?.sizeBytes ?? 0} bytes)`;

    return {
      output: `Deliverable "${filename}" (${primaryArt?.sizeBytes ?? 0} bytes) generated and verified. ${checkSummary}. Saved to disk at ${primaryArt?.relativePath || filename}. Deliverable creation is complete.`,
      summary: `Created deliverable: ${filename}`,
      artifacts,
      sideEffects: [`artifact:${filename}`],
    };
  },
};

export const specialistTools: AgentTool[] = [
  extractDocumentTool,
  generateCodeTool,
  generateTextTool,
  retrieveKnowledgeTool,
  executePythonTool,
  generateDeliverableTool,
];
