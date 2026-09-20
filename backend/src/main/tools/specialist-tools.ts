import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { requestBase } from "../gateway/model-gateway.js";
import { executePython } from "./python.js";
import { generateDocx, generateXlsx } from "./artifacts.js";
import { resolveRunPath } from "../run/filesystem.js";
import type {
  ArtifactRef,
  CodeModelRequest,
  DraftModelRequest,
  PythonExecutionResult,
  VisionModelRequest,
} from "../../shared/contracts.js";

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
    const filename = String(args.filename ?? "");
    const query = String(args.query ?? "Extract all findings, measurements, and annotations from this document.");
    const inputDir = resolveRunPath(context.runId, "input", "input");
    const filePath = path.join(inputDir, filename);

    if (!existsSync(filePath)) {
      throw new Error(`Attached file "${filename}" not found in run input directory`);
    }

    const ext = path.extname(filename).toLowerCase();
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
      devWorkload: context.devWorkload,
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
      devWorkload: context.devWorkload,
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
      devWorkload: context.devWorkload,
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
    const code = String(args.code ?? "");
    const filename = String(args.filename ?? "task.py");
    const inputFiles = Array.isArray(args.input_files) ? args.input_files.map(String) : [];

    const intermediateDir = resolveRunPath(context.runId, "intermediate", "intermediate");
    const scriptPath = path.join(intermediateDir, filename);
    writeFileSync(scriptPath, code, "utf8");

    const execResult = await executePython(context.runId, filename, inputFiles, []);
    const summary = `Executed Python (${filename}): exit ${execResult.exitCode} in ${execResult.durationMs}ms`;

    return {
      output: JSON.stringify(execResult, null, 2),
      summary,
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
      description: "Generate an official deliverable document (Word .docx, Excel .xlsx, or Markdown .md) in the run output folder.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["docx", "xlsx", "md"], description: "Format of the deliverable." },
          title: { type: "string", description: "Document title or subject." },
          content: { type: "string", description: "Text or markdown content for the deliverable." },
          filename: { type: "string", description: "Desired deliverable filename (e.g. 'approval-note.docx', 'findings.md')." },
        },
        required: ["type", "content"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const type = String(args.type ?? "md").toLowerCase();
    const title = String(args.title ?? "Deliverable");
    const content = String(args.content ?? "");
    let filename = String(args.filename ?? `deliverable.${type}`);
    if (!filename.endsWith(`.${type}`)) filename += `.${type}`;

    const artifacts: ArtifactRef[] = [];

    if (type === "docx") {
      const art = await generateDocx(context.runId, { title, body: content, sections: [] }, filename);
      artifacts.push(art);
    } else if (type === "xlsx") {
      const mockExec: PythonExecutionResult = {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        outputFiles: [],
        durationMs: 0,
      };
      const art = await generateXlsx(context.runId, mockExec, filename);
      artifacts.push(art);
    } else {
      const outDir = resolveRunPath(context.runId, "output", "output");
      const outPath = path.join(outDir, filename);
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
      output: `Generated deliverable "${filename}" (${artifacts[0]?.sizeBytes ?? 0} bytes)`,
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
