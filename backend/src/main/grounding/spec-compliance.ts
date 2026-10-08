import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ModelGateway } from "../gateway/model-gateway.js";
import type { ChatModelRequest, ArtifactRef, Finding } from "../../shared/contracts.js";
import { requestBase } from "../gateway/model-gateway.js";
import { writeRunFile, artifactRef } from "../run/filesystem.js";
import type { RAGService } from "../rag/rag-service.js";

// ── Data Interfaces ─────────────────────────────────────────────────────────

export interface ObservedComponent {
  tag?: string;
  componentType: string;
  attributeName: string;
  observedValue: string;
  numericValue?: number;
  unit?: string;
  location?: string;
  fullDescription: string;
}

export interface DrawingExtractionResult {
  drawingId: string;
  title: string;
  service?: string;
  notes: string[];
  observedComponents: ObservedComponent[];
  rawText: string;
}

export interface ComplianceCheck {
  component: string;
  observed: string;
  required: string;
  status: "compliant" | "non_compliant" | "unverified";
  citation: string;
  reasoning: string;
  correctiveAction?: string;
}

export interface ComplianceAssessment {
  drawingId: string;
  approved: boolean;
  checks: ComplianceCheck[];
  correctiveAction: string;
  markdownNote: string;
}

export interface SpecSectionChunk {
  chunkId: string;
  docId: string;
  sectionLabel: string;
  sectionTitle?: string;
  text: string;
  citation: string;
}

// ── Attribute Extraction from Drawing (SVG or Multimodal) ───────────────────

/**
 * Extracts observed component attributes from drawing content (SVG text nodes, labels, tags, ratings).
 */
export function extractDrawingAttributes(input: {
  filename: string;
  mediaType: string;
  rawBuffer?: Buffer;
  text?: string;
  visionFindings?: Finding[];
}): DrawingExtractionResult {
  const rawString =
    input.rawBuffer ? input.rawBuffer.toString("utf8") : input.text ?? "";
  const isSvg =
    input.mediaType === "image/svg+xml" ||
    input.filename.toLowerCase().endsWith(".svg") ||
    rawString.includes("<svg");

  let drawingId = "UNKNOWN-DRAWING";
  let title = "Engineering Drawing";
  let service: string | undefined;
  const notes: string[] = [];
  const textLines: string[] = [];
  const observedComponents: ObservedComponent[] = [];

  if (isSvg) {
    // Extract text from all <text> elements
    const textTagRegex = /<text[^>]*>([\s\S]*?)<\/text>/gi;
    let match: RegExpExecArray | null;
    while ((match = textTagRegex.exec(rawString)) !== null) {
      const clean = match[1].replace(/<[^>]+>/g, "").trim();
      if (clean) textLines.push(clean);
    }

    // Extract the drawing ID from source metadata.
    for (const line of textLines) {
      const dwgMatch =
        line.match(/\b(Drawing:\s*([^\s|]+))/i) ||
        line.match(/\b([A-Z]{2,4}-[A-Z0-9]{2,8}-REV-[A-Z0-9]+)\b/i) ||
        line.match(/\b(PID-[A-Z0-9_-]+)\b/i);
      if (dwgMatch) {
        drawingId = (dwgMatch[2] || dwgMatch[1] || dwgMatch[0]).replace(/^Drawing:\s*/i, "").trim();
      }

      // Title line
      if (/DESIGN REVIEW|P&ID|FLOW DIAGRAM|PIPING/i.test(line) && !service) {
        title = line;
      }

      // Extract service descriptions only when they appear in the source.
      const serviceMatch = line.match(/\b([A-Za-z\s]+ service)\b/i);
      if (serviceMatch) {
        service = serviceMatch[1].trim();
      }

      // Review notes / targets
      if (/review target|target:|note:|check/i.test(line) && !line.startsWith("Drawing:")) {
        notes.push(line);
      }
    }

    // Extract only labels and values that appear in the source text.
    const identifierPattern = /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g;
    const identifiers = new Set<string>();
    for (const line of textLines) {
      for (const match of line.matchAll(identifierPattern)) {
        const identifier = match[0];
        if (identifier !== drawingId) identifiers.add(identifier);
      }
    }
    for (const tag of identifiers) {
      observedComponents.push({
        tag,
        componentType: "labeled item",
        attributeName: "identifier",
        observedValue: tag,
        fullDescription: tag,
      });
    }

    const classLineIndex = textLines.findIndex((line) => /\bclass\s*\d+\b/i.test(line));
    if (classLineIndex >= 0) {
      const rating = textLines[classLineIndex].match(/\bclass\s*\d+\b/i)?.[0];
      if (rating) {
        const adjacentLines = textLines.slice(Math.max(0, classLineIndex - 1), classLineIndex + 2).join(" ");
        const tag = adjacentLines.match(identifierPattern)?.[0];
        const location = adjacentLines.match(/\b(?:at|on|near|along)\s+([^,;]+)/i)?.[1]?.trim();
        observedComponents.push({
          tag,
          componentType: "component",
          attributeName: "rating",
          observedValue: rating,
          numericValue: Number(rating.match(/\d+/)?.[0]),
          unit: "class",
          location,
          fullDescription: `${tag ? `${tag} ` : ""}${rating}${location ? ` (${location})` : ""}`,
        });
      }
    }

    const sizePattern = /\bDN\s*\d+\b|\b\d+(?:\.\d+)?\s*(?:inch(?:es)?|\")/i;
    for (const line of textLines.filter((item) => sizePattern.test(item))) {
      const size = line.match(sizePattern)?.[0]?.trim();
      if (!size) continue;
      const number = size.match(/\d+(?:\.\d+)?/)?.[0];
      const location = line.match(/\b(?:suction|discharge|inlet|outlet)\b/i)?.[0];
      const tag = line.match(identifierPattern)?.[0];
      observedComponents.push({
        tag,
        componentType: "dimension",
        attributeName: "nominal size",
        observedValue: line,
        numericValue: number ? Number(number) : undefined,
        unit: /^DN/i.test(size) ? "DN" : "inch",
        location,
        fullDescription: line,
      });
    }
  }

  // Multimodal vision findings fusion (if vision model ran)
  if (input.visionFindings && input.visionFindings.length > 0) {
    for (const f of input.visionFindings) {
      const titleLower = f.title.toLowerCase();
      const valLower = f.value.toLowerCase();

      // Check if already captured
      const alreadyCaptured = observedComponents.some(
        (c) =>
          c.fullDescription.toLowerCase().includes(titleLower) ||
          c.observedValue.toLowerCase().includes(valLower),
      );

      if (!alreadyCaptured) {
        const numMatch = f.value.match(/(\d+(?:\.\d+)?)/);
        observedComponents.push({
          componentType: f.title,
          attributeName: f.title,
          observedValue: f.value,
          numericValue: numMatch ? parseFloat(numMatch[1]) : undefined,
          fullDescription: `${f.title}: ${f.value}`,
        });
      }
    }
  }

  return {
    drawingId,
    title,
    service,
    notes,
    observedComponents,
    rawText: textLines.join("\n"),
  };
}

// ── Governing Spec Resolution & RAG Ingestion ──────────────────────────────

/**
 * Ensures the governing specification is indexed in the Knowledge Base / RAGService.
 */
export async function ensureGoverningSpecIndexed(
  ragService: RAGService | undefined,
  options: {
    attachedSpecFile?: { filename: string; relativePath: string };
    promptText: string;
    workspaceRoot?: string;
  },
): Promise<{ docId: string; specContent?: string }> {
  // 1. Check if user attached a spec document directly in this run
  if (options.attachedSpecFile && ragService) {
    const filePath = path.resolve(options.attachedSpecFile.relativePath);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf8");
      const idMatch =
        content.match(/\b(SOP[-\s]?\d+|SPEC[-\s]?\d+)\b/i) ||
        options.attachedSpecFile.filename.match(/\b(SOP[-\s]?\d+|SPEC[-\s]?\d+)\b/i);
      const docId = idMatch
        ? idMatch[1].replace(/\s+/g, "-").toUpperCase()
        : path.basename(options.attachedSpecFile.filename, path.extname(options.attachedSpecFile.filename));
      await ragService.ingestDocument(
        {
          doc_id: docId,
          title: `Governing Spec: ${options.attachedSpecFile.filename}`,
          source_path: filePath,
          doc_type: "sop",
          department: "Engineering",
          effective_date: new Date().toISOString().slice(0, 10),
          page_count: 1,
          ocr_used: false,
          indexed_at: new Date().toISOString(),
        },
        filePath,
      );
      return { docId, specContent: content };
    }
  }

  // Only resolve a specification named by the user in the selected workspace.
  const specMatch = options.promptText.match(/\b((?:SOP|SPEC)[-\s]?\d+)\b/i);
  const detectedSpec = specMatch ? specMatch[1].replace(/\s+/g, "-").toUpperCase() : "";
  const candidatePaths = options.workspaceRoot && detectedSpec
    ? [path.join(options.workspaceRoot, `${detectedSpec}.md`)] : [];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, "utf8");
      const baseName = path.basename(candidate, path.extname(candidate));
      const docId = content.match(/^Document ID:\s*`?([^`\s]+)/im)?.[1] ?? baseName;

      if (ragService) {
        try {
          await ragService.ingestDocument(
            {
              doc_id: docId,
              title: `Governing Spec ${docId}`,
              source_path: candidate,
              doc_type: "sop",
              department: "Engineering",
              effective_date: new Date().toISOString().slice(0, 10),
              page_count: 1,
              ocr_used: false,
              indexed_at: new Date().toISOString(),
            },
            candidate,
          );
        } catch {
          // May already be indexed or initialized
        }
      }
      return { docId, specContent: content };
    }
  }

  return { docId: detectedSpec };
}

/**
 * Retrieves relevant sections of governing specification from Knowledge Base / RAGService.
 */
export async function retrieveGoverningSpecChunks(
  ragService: RAGService | undefined,
  specContent: string | undefined,
  docId: string,
  queryTerms: string,
): Promise<SpecSectionChunk[]> {
  const chunks: SpecSectionChunk[] = [];

  // If RAGService is available and initialized, query it
  if (ragService) {
    try {
      const results = await ragService.query(queryTerms, 6);
      for (const r of results) {
        const sec = r.section_label && r.section_label !== "unknown" ? r.section_label : "";
        const effectiveDocId = docId || r.doc_id;
        const citation = `[${effectiveDocId.toUpperCase()}${sec ? ` §${sec}` : ""}]`;
        chunks.push({
          chunkId: r.chunk_id,
          docId: effectiveDocId,
          sectionLabel: sec,
          sectionTitle: (r as any).section_title || r.section_label,
          text: r.text,
          citation,
        });
      }
    } catch {
      // Fall through to direct content parsing if RAGService query encounters issue
    }
  }

  // Parse direct spec content if available (guarantees exact clause labels like §4.2, §4.3)
  if (specContent && chunks.length === 0) {
    const sections = specContent.split(/\n(?=##\s+)/);
    for (const sec of sections) {
      const trimmed = sec.trim();
      if (!trimmed) continue;

      const headerMatch = trimmed.match(/^##\s+\[\s*section:\s*([0-9A-Za-z._-]+)\s*\]\s*(.*)$/im);
      if (headerMatch) {
        const secLabel = headerMatch[1];
        const title = headerMatch[2].trim();
        const citation = `[${docId} §${secLabel}]`;
        chunks.push({
          chunkId: `${docId}-c${secLabel}`,
          docId,
          sectionLabel: secLabel,
          sectionTitle: title,
          text: trimmed,
          citation,
        });
      }
    }
  }

  return chunks;
}

// ── Model-Driven Dynamic Compliance Reasoning ───────────────────────────────

const COMPLIANCE_SYSTEM_PROMPT = `Review supplied source evidence against relevant criteria retrieved from the user's sources or knowledge base.

Keep observations separate from requirements. Preserve exact source identifiers and associate each fact with its source. Assess only items that the evidence and criteria allow you to assess. Cite the exact document and section for each requirement. Give actions only when supported by the request and evidence. Mark missing or uncertain evidence clearly. Do not invent limits, outcomes, approval decisions, or completed actions.

Output strictly valid JSON matching this schema:
{
  "drawingId": string,
  "approved": boolean,
  "checks": [
    {
      "component": string,
      "observed": string,
      "required": string,
      "status": "compliant" | "non_compliant" | "unverified",
      "citation": string,
      "reasoning": string,
      "correctiveAction": string
    }
  ],
  "correctiveAction": string,
  "markdownNote": string
}`;

/**
 * Prompts the reasoning model to dynamically compare each observed parameter against the retrieved spec requirements.
 */
export async function evaluateDrawingComplianceWithModel(options: {
  gateway: ModelGateway;
  runId: string;
  drawing: DrawingExtractionResult;
  specChunks: SpecSectionChunk[];
  docId: string;
  temperature?: number;
}): Promise<ComplianceAssessment> {
  const { gateway, runId, drawing, specChunks, docId, temperature = 0.1 } = options;

  // Format observed drawing components
  const observedBlock = drawing.observedComponents
    .map(
      (c) =>
        `- Component: ${c.fullDescription} (Tag: ${c.tag ?? "N/A"}, Type: ${c.componentType}, Value: ${c.observedValue.toUpperCase()}, Raw: ${c.observedValue}${c.location ? `, Location: ${c.location}` : ""})`,
    )
    .join("\n");

  // Format retrieved governing spec chunks
  const specBlock = specChunks
    .map(
      (chunk) =>
        `### Excerpt ${chunk.citation} — ${chunk.sectionTitle ?? `Section ${chunk.sectionLabel}`}\n${chunk.text}`,
    )
    .join("\n\n---\n\n");

  const prompt = [
    `## Source: ${drawing.drawingId} (${drawing.title})`,
    drawing.service ? `Service: ${drawing.service}` : "",
    "",
    "### Observed Attributes:",
    observedBlock || "- No structured components extracted.",
    "### Extracted Source Labels and Text:",
    drawing.rawText || "- No text was extracted.",
    "",
    `### Governing Specification Excerpts (${docId}):`,
    specBlock || "- No specific specification excerpts retrieved.",
    "",
    "Assess each relevant observation against the available requirements. Preserve exact identifiers. Use an unverified status when the evidence does not support a conclusion. Return the requested structure without adding unrelated findings.",
  ]
    .filter(Boolean)
    .join("\n");

  const base = requestBase(
    runId,
    "draft",
    "primary-model",
    "chat-result",
    COMPLIANCE_SYSTEM_PROMPT,
    prompt,
    60000,
    2048,
    temperature,
  );

  const request: ChatModelRequest = {
    ...base,
    taskType: "draft",
    modelId: "primary-model",
    responseFormat: "chat-result",
  };

  {
    const response = await gateway.execute(request);
    if (!response.ok) throw new Error(`Compliance model failed: ${response.error.message}`);
    if (response.ok) {
      const resultObj = response.value.result as { text?: string };
      const rawText = resultObj.text ?? JSON.stringify(resultObj);
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as ComplianceAssessment;
        if (parsed.checks && Array.isArray(parsed.checks) && typeof parsed.approved === "boolean") {
          return {
            drawingId: parsed.drawingId || drawing.drawingId,
            approved: parsed.approved,
            checks: parsed.checks,
            correctiveAction: parsed.correctiveAction || "",
            markdownNote: parsed.markdownNote || createCorrectiveActionMarkdown(drawing.drawingId, parsed.checks),
          };
        }
      }
    }
  }
  throw new Error("Compliance model returned no valid structured assessment; no substitute findings were generated.");
}

export function createCorrectiveActionMarkdown(
  drawingId: string,
  checks: ComplianceCheck[],
): string {
  const nonCompliant = checks.filter((c) => c.status === "non_compliant");

  const lines = [
    `# Grounded Assessment — ${drawingId}`,
    "",
    "| Identifier | Observation | Requirement | Assessment | Action | Evidence |",
    "|---|---|---|---|---|---|",
  ];

  if (checks.length > 0) {
    checks.forEach((c) => {
      lines.push(`| ${c.component} | ${c.observed} | ${c.required} | ${c.status} | ${c.correctiveAction ?? ""} | ${c.citation}${c.reasoning ? ` — ${c.reasoning}` : ""} |`);
    });
  }

  if (nonCompliant.length > 0) {
    nonCompliant.forEach((c, idx) => {
      if (c.correctiveAction) {
        lines.push(`${idx + 1}. ${c.correctiveAction}`);
      }
    });
  }

  lines.push("This is an evidence-based review. Follow the applicable approval process for decisions outside this assessment.");

  return lines.join("\n");
}

/**
 * Generates and writes `corrective-action-note.md` to `data/runs/<runId>/output/`.
 */
export function generateComplianceNoteArtifact(
  runId: string,
  assessment: ComplianceAssessment,
  filename = "corrective-action-note.md",
): ArtifactRef {
  const relativePath = writeRunFile(
    runId,
    "output",
    filename,
    assessment.markdownNote,
    true,
  );

  return artifactRef(runId, "md", filename, relativePath);
}
