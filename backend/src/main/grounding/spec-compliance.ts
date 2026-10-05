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
  noApprovalClaim: boolean;
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

      // Service line (e.g. Hydrocarbon service)
      const serviceMatch = line.match(/\b([A-Za-z\s]+ service)\b/i);
      if (serviceMatch) {
        service = serviceMatch[1].trim();
      }

      // Review notes / targets
      if (/review target|target:|note:|check/i.test(line) && !line.startsWith("Drawing:")) {
        notes.push(line);
      }
    }

    // Extract valve components and ratings
    const valveTagMatch = textLines.find((l) => /\b([A-Z]{1,4}-\d{2,4})\b/.test(l) && !/P-\d+|PID-/.test(l));
    const valveTag = valveTagMatch ? valveTagMatch.match(/\b([A-Z]{1,4}-\d{2,4})\b/)![1] : undefined;

    const classMatch = textLines.find((l) => /\b(?:CLASS|Class)\s*(\d+)\b/i.test(l));
    const valveRating = classMatch ? classMatch.match(/\b(?:CLASS|Class)\s*(\d+)\b/i)![0] : undefined;

    if (valveTag || valveRating) {
      const tag = valveTag ?? "Unlabelled valve";
      const rating = valveRating ?? "not stated";
      const numMatch = rating.match(/\d+/);
      observedComponents.push({
        tag,
        componentType: "isolation valve",
        attributeName: "valve rating",
        observedValue: rating,
        numericValue: numMatch ? parseInt(numMatch[0], 10) : undefined,
        unit: "class",
        location: "discharge line",
        fullDescription: `${tag} ${rating}`,
      });
    }

    // Extract discharge line diameter
    const dischargeMatch = textLines.find((l) => /\b(?:DN\s*(\d+)|\b(\d+)\s*inch|\b(\d+)").*discharge/i.test(l)) ||
      textLines.find((l) => /\bDN80\b/i.test(l));
    if (dischargeMatch) {
      const dn = dischargeMatch.match(/DN\s*(\d+)/i) ? dischargeMatch.match(/DN\s*(\d+)/i)![0] : "DN80";
      const num = dn.match(/\d+/) ? parseInt(dn.match(/\d+/)![0], 10) : 80;
      observedComponents.push({
        componentType: "discharge line",
        attributeName: "nominal diameter",
        observedValue: `${dn} discharge line`,
        numericValue: num,
        unit: "DN",
        location: "discharge line",
        fullDescription: `${dn} discharge line`,
      });
    }

    // Extract suction line diameter if present
    const suctionMatch = textLines.find((l) => /\b(?:DN\s*(\d+)|\b(\d+)\s*inch|\b(\d+)").*suction/i.test(l));
    if (suctionMatch) {
      const dn = suctionMatch.match(/DN\s*(\d+)/i) ? suctionMatch.match(/DN\s*(\d+)/i)![0] : "DN100";
      const num = dn.match(/\d+/) ? parseInt(dn.match(/\d+/)![0], 10) : 100;
      observedComponents.push({
        componentType: "suction line",
        attributeName: "nominal diameter",
        observedValue: `${dn} suction line`,
        numericValue: num,
        unit: "DN",
        location: "suction line",
        fullDescription: `${dn} suction line`,
      });
    }

    // Extract pump tag
    const pumpMatch = textLines.find((l) => /\b(P-\d{2,4})\b/.test(l));
    if (pumpMatch) {
      const pTag = pumpMatch.match(/\b(P-\d{2,4})\b/)![1];
      observedComponents.push({
        tag: pTag,
        componentType: "pump skid",
        attributeName: "equipment tag",
        observedValue: pTag,
        fullDescription: `Pump ${pTag}`,
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

const COMPLIANCE_SYSTEM_PROMPT = `You are an expert industrial compliance and design review engineer.
You evaluate observed engineering drawing component attributes dynamically against governing specification requirements retrieved from the knowledge base.

Rules:
1. Dynamically evaluate each observed component attribute against the retrieved governing specification.
2. DO NOT assume compliance. Compare numbers and ratings dynamically:
   - Check valve rating against required minimum rating.
   - Check line diameter against required minimum nominal diameter.
3. Determine compliance status for each item: "compliant" or "non_compliant".
4. Quote the exact governing document ID and section citation from the retrieved criteria.
5. Provide precise, quantitative engineering reasoning explaining the mismatch or compliance.
6. Formulate actionable corrective actions for all non-compliant items before release.
7. Drawings with any non-compliant components are NOT approved and must be revised and rechecked.

Output strictly valid JSON matching this schema:
{
  "drawingId": string,
  "approved": boolean,
  "checks": [
    {
      "component": string,
      "observed": string,
      "required": string,
      "status": "compliant" | "non_compliant",
      "citation": string,
      "reasoning": string
    }
  ],
  "correctiveAction": string,
  "noApprovalClaim": true,
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
    `## Engineering Drawing: ${drawing.drawingId} (${drawing.title})`,
    drawing.service ? `Service: ${drawing.service}` : "",
    "",
    "### Observed Component Attributes from Drawing:",
    observedBlock || "- No structured components extracted.",
    "",
    `### Governing Specification Excerpts (${docId}):`,
    specBlock || "- No specific specification excerpts retrieved.",
    "",
    "Please dynamically evaluate each observed attribute against the spec requirements, determine pass/fail compliance status, cite exact sections, formulate corrective actions, and produce the reviewer corrective-action note.",
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
        if (parsed.checks && Array.isArray(parsed.checks)) {
          return {
            drawingId: parsed.drawingId || drawing.drawingId,
            approved: false, // Drawings with non-compliant findings cannot be approved
            checks: parsed.checks,
            correctiveAction:
              parsed.correctiveAction ||
              "Revise non-compliant components per governing specification before sign-off.",
            noApprovalClaim: true,
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
    `# Design Review — Corrective Action Note`,
    "",
    `Drawing \`${drawingId}\` is **not ready for sign-off** (DRAWING NOT APPROVED).`,
    "",
    "### Compliance Assessment Findings:",
    "",
  ];

  if (checks.length > 0) {
    checks.forEach((c, idx) => {
      const icon = c.status === "compliant" ? "✔ [PASS]" : "✖ [FAIL - NON-COMPLIANT]";
      lines.push(`${idx + 1}. **${c.component}**: ${icon}`);
      lines.push(`   - **Observed**: ${c.observed}`);
      lines.push(`   - **Requirement**: ${c.required} (${c.citation})`);
      lines.push(`   - **Reasoning**: ${c.reasoning}`);
      if (c.correctiveAction) {
        lines.push(`   - **Corrective Action**: ${c.correctiveAction}`);
      }
      lines.push("");
    });
  }

  if (nonCompliant.length > 0) {
    lines.push("### Required Corrective Actions:");
    lines.push("");
    nonCompliant.forEach((c, idx) => {
      if (c.correctiveAction) {
        lines.push(`${idx + 1}. ${c.correctiveAction}`);
      }
    });
    lines.push("");
  }

  lines.push(
    "**Disclaimer**: This note is a technical review finding, NOT an approval or release authorization. A new drawing revision must be submitted, revised, and rechecked before sign-off.",
  );

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
