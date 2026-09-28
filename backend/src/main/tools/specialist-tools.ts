import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { requestBase } from "../gateway/model-gateway.js";
import { executePython } from "./python.js";
import { generateDocx, generateXlsx, generateXlsxFromContent } from "./artifacts.js";
import { resolveRunPath } from "../run/filesystem.js";
import { extractContentArg, extractPathArg, findFileInRunDirectories } from "./workspace-tools.js";
import type {
  ArtifactKind,
  ArtifactRef,
  CodeModelRequest,
  DraftModelRequest,
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
    if (!rawPath.trim()) {
      throw new Error(`extract_document requires a filename or path parameter. Received: ${JSON.stringify(args)}`);
    }
    const query = String(args.query ?? "Extract all findings, measurements, and annotations from this document.");

    let filePath: string | null = null;
    if (context.workspaceRoot) {
      try {
        const resolved = path.resolve(context.workspaceRoot, rawPath);
        if (existsSync(resolved)) filePath = resolved;
      } catch {}
    }
    if (!filePath && context.runId) {
      filePath = findFileInRunDirectories(context.runId, rawPath);
    }
    if (!filePath && existsSync(rawPath)) {
      filePath = rawPath;
    }

    if (!filePath || !existsSync(filePath)) {
      throw new Error(`Attached file "${rawPath}" not found in run directories or workspace`);
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
        const svgText = extractSvgText(raw);
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

    const base = requestBase(
      context.runId,
      "vision",
      "vision-qwen25vl",
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
      modelId: "vision-qwen25vl",
      responseFormat: "vision-result",
      attachment: {
        attachmentId: randomUUID(),
        filename,
        mediaType,
        sizeBytes: 0,
        relativePath: `runs/${context.runId}/input/${filename}`,
      },
      inputMode: "typed-scan",
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
    const spec = String(args.spec ?? "");
    const filename = String(args.filename ?? "task.py");
    const base = requestBase(
      context.runId,
      "code",
      "code-qwen25coder",
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
      modelId: "code-qwen25coder",
      responseFormat: "code-result",
      task: spec,
      inputFile: { attachmentId: randomUUID(), filename, mediaType: "text/x-python", rowCount: 1 },
      allowedLanguage: "python",
      executionRules: ["sandbox-isolated"],
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
    const prompt = String(args.prompt ?? "");
    const extraContext = args.context ? `\n\nCONTEXT:\n${String(args.context)}` : "";
    const base = requestBase(
      context.runId,
      "draft",
      "draft-qwen3",
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
      modelId: "draft-qwen3",
      responseFormat: "chat-result",
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
    const query = String(args.query ?? "");
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
      description: "Execute Python code inside the secure, air-gapped sandbox without network access. Captures stdout, stderr, exit code, and created files.",
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
    if (!code.trim()) {
      throw new Error("execute_python requires 'code' (or 'script') containing Python source code to execute.");
    }
    const filename = String(args.filename ?? "task.py");
    let inputFiles: string[] = [];
    if (Array.isArray(args.input_files)) {
      inputFiles = args.input_files.map((f) => path.basename(String(f).trim())).filter(Boolean);
    } else if (typeof args.input_files === "string" && args.input_files.trim()) {
      inputFiles = args.input_files.split(",").map((f) => path.basename(f.trim())).filter(Boolean);
    } else if (typeof args.input_file === "string" && args.input_file.trim()) {
      inputFiles = [path.basename(args.input_file.trim())];
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
    const scriptPath = path.join(intermediateDir, filename);
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

    const execResult = await executePython(context.runId, filename, inputFiles, [], 60000, context.workspaceRoot);
    const summary = `Executed Python (${filename}): exit ${execResult.exitCode} in ${execResult.durationMs}ms`;

    const artifacts: ArtifactRef[] = [];
    const outputDir = resolveRunPath(context.runId, "output", "output");

    // Collect any output files created during execution
    for (const outFile of execResult.outputFiles) {
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
    try {
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
      const artifactScriptFilename =
        targetName.startsWith("repaired-") || targetName.startsWith("fixed-")
          ? targetName
          : `repaired-${targetName}`;
      const scriptOutPath = path.join(outputDir, artifactScriptFilename);
      writeFileSync(scriptOutPath, code, "utf8");
      if (artifactScriptFilename.includes("-")) {
        const underscoredArtifact = artifactScriptFilename.replace(/-/g, "_");
        writeFileSync(path.join(outputDir, underscoredArtifact), code, "utf8");
      }
      artifacts.push({
        artifactId: randomUUID(),
        runId: context.runId,
        kind: "txt",
        filename: artifactScriptFilename,
        relativePath: `runs/${context.runId}/output/${artifactScriptFilename}`,
        sizeBytes: Buffer.byteLength(code, "utf8"),
        createdAt: new Date().toISOString(),
      });
    } catch {}

    return {
      output: JSON.stringify(execResult, null, 2),
      summary,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      sideEffects: [`executed:${filename}`],
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
        "Generate an official deliverable document file (Word .docx, Excel .xlsx, or Markdown .md) in the run output folder. Use ONLY when the user explicitly requests an export file, report document, or formal deliverable. Do NOT invoke if the user is only asking for a review, comparison, explanation, or direct engineering answers in chat.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["docx", "xlsx", "md"],
            description: "Format of the deliverable document: 'docx' for Word, 'xlsx' for Excel spreadsheet, 'md' for Markdown report.",
          },
          title: {
            type: "string",
            description: "Formal title of the deliverable document.",
          },
          content: {
            type: "string",
            description:
              "The complete, publication-grade document body in Markdown. Must contain the full synthesized engineering findings, actual measured values, and complete Markdown tables with real data rows. Do NOT pass template outlines or placeholder text.",
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
    const type = String(args.type ?? "md").toLowerCase();
    let title = String(args.title ?? "Deliverable");
    let content = String(args.content ?? "");
    let filename = String(args.filename ?? `deliverable.${type}`);
    if (!filename.endsWith(`.${type}`)) filename += `.${type}`;

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
        throw new Error(
          `Cannot generate deliverable "${filename}" with placeholder or empty content. ` +
          `You must first inspect input files (using read_file or extract_document), synthesize the findings, ` +
          `and call generate_deliverable with complete, comprehensive, publication-ready markdown or text content.`
        );
      }
    }

    // If content contains template placeholder text ("Markdown table with columns"), enrich with the actual completed table
    if (
      /Markdown table with columns/i.test(content) &&
      !/\|[^\n]+\|[^\n]+\|\r?\n\|[-:\s|]+\|\r?\n\|[^\n]+\|[^\n]+\|/.test(content)
    ) {
      const realTableMatch = context.lastAssistantContent?.match(
        /(?:^|\n)\s*(\|?[^\n]+\|\r?\n\s*\|?[-:\s|]+\|\r?\n(?:\s*\|?[^\n]+\|\r?\n?)+)/m
      );
      if (realTableMatch && realTableMatch[1]) {
        const extractedTable = realTableMatch[1].trim();
        content = content.replace(/.*Markdown table with columns.*/i, extractedTable);
      } else if (
        context.lastAssistantContent &&
        context.lastAssistantContent.length > 200 &&
        /#+\s+/m.test(context.lastAssistantContent) &&
        /\|[^\n]+\|[^\n]+\|/m.test(context.lastAssistantContent)
      ) {
        content = context.lastAssistantContent;
      } else {
        throw new Error(
          `Cannot generate deliverable "${filename}" with template placeholder text ("Markdown table with columns"). ` +
          `You must provide the complete document content with actual measured values and completed Markdown table rows.`
        );
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
      const outDir = resolveRunPath(context.runId, "output", "output");
      const outPath = path.join(outDir, filename);
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, content, "utf8");
      artifacts.push({
        artifactId: randomUUID(),
        runId: context.runId,
        kind: "md",
        filename,
        relativePath: `runs/${context.runId}/output/${filename}`,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        createdAt: new Date().toISOString(),
      });
    }

    return {
      output: `Generated deliverable "${filename}" (${artifacts[0]?.sizeBytes ?? 0} bytes) successfully. The file is compiled, verified, and saved to disk in the run output folder. Deliverable creation is complete. Do not re-read this file.`,
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
