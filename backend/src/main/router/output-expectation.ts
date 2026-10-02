import path from "node:path";
import type { AttachmentReference, OutputExpectation } from "../../shared/contracts.js";
import type { SemanticIntent } from "./contextual-router.js";

export { OutputExpectation };

export interface DetermineOutputExpectationOptions {
  attachments?: AttachmentReference[];
  hasWorkspace?: boolean;
  workspaceFiles?: string[];
  semanticIntent?: Partial<SemanticIntent>;
}

/**
 * Checks whether the prompt represents a purely informational inquiry, explanation,
 * architectural review, or conceptual question that does NOT request creating or modifying files.
 */
export function isInformationalInquiry(userPrompt: string): boolean {
  const trimmed = userPrompt.trim();
  const lower = trimmed.toLowerCase();

  // If prompt explicitly instructs writing, saving, exporting, or creating files, it's not pure inquiry
  const hasExplicitSaveOrMutation =
    /\b(?:save\s+(?:it\s+)?to|write\s+(?:it\s+)?to|update\s+[\w.-]+\.\w+|create\s+(?:a\s+)?(?:file|workbook|spreadsheet|document)|export\s+(?:to|as))\b/i.test(
      lower,
    );

  if (hasExplicitSaveOrMutation) {
    return false;
  }

  // Starts with question or explanation phrasing
  if (
    /^(?:explain|describe|what\s+is|what\s+are|what\s+does|why\s+does|why\s+is|how\s+does|how\s+do|how\s+can|how\s+to|show\s+me|tell\s+me|can\s+you\s+(?:explain|describe|show|clarify|summarize|tell)|walk\s*through|summarize|help\s+me\s+understand|check\s+if|does\s+this|is\s+this|review\b)\b/i.test(
      lower,
    )
  ) {
    return true;
  }

  // Contains question mark or explanation keywords without explicit action
  if (
    trimmed.endsWith("?") ||
    /\b(?:explain|explanation|show\s+me\s+how|walkthrough|overview|meaning\s+of)\b/i.test(lower)
  ) {
    return true;
  }

  return false;
}

/**
 * Detects whether the user explicitly requested output deliverables (Word documents,
 * Excel spreadsheets, CSV exports, standalone reports) and determines their expected names.
 */
export function detectDeliverableExpectations(
  userPrompt: string,
  inputFiles: string[] = [],
): string[] {
  const lower = userPrompt.toLowerCase();
  const deliverables: string[] = [];
  const lowerInputs = new Set(inputFiles.map((f) => f.toLowerCase()));

  // 1. Detect explicit deliverable filenames in prompt (e.g. "report.docx", "cleaned.xlsx", "output.csv")
  const fileRegex = /\b([a-zA-Z0-9_\-.]+\.(?:docx|xlsx|csv|pdf|md))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(userPrompt)) !== null) {
    const raw = match[1];
    const rawLower = raw.toLowerCase();
    if (lowerInputs.has(rawLower)) continue;

    const start = match.index;
    const preceding = userPrompt.slice(Math.max(0, start - 30), start).toLowerCase();

    // Skip if preceded by read/inspect/from keywords
    if (/\b(?:from|inspect|read|parse|examine|using|check|input|about|explain)\s+(?:a\s+|an\s+|the\s+)?$/i.test(preceding)) {
      continue;
    }

    const isCreationContext =
      /\b(?:in|into|as|to|draft|generate|create|produce|compile|export|save|named)\s+(?:a\s+|an\s+|the\s+)?$/i.test(preceding) ||
      /\b(?:generate|create|produce|compile|export|draft|save)\b/i.test(userPrompt);

    if (isCreationContext && !deliverables.includes(raw)) {
      deliverables.push(raw);
    }
  }

  // 2. Detect requested deliverable categories when explicit filename is not given
  // A. DOCX / Word deliverable / Approval Note
  const requestsDocx =
    /\b(?:draft|generate|create|produce|compile|export)\b[^.?!]*\b(?:approval\s+note|compliance\s+note|word\s+doc(?:ument)?|docx|formal\s+note|report)\b/i.test(lower) ||
    /\b(?:as|in|into)\s+(?:a\s+)?(?:word\s+document|docx\s+file|docx)\b/i.test(lower);
  const hasDocx = deliverables.some((f) => f.toLowerCase().endsWith(".docx"));
  if (requestsDocx && !hasDocx) {
    const name = /\breport\b/i.test(lower) ? "report.docx" : "approval-note.docx";
    deliverables.push(name);
  }

  // B. XLSX / Excel spreadsheet / Workbook
  const requestsXlsx =
    /\b(?:generate|create|produce|compile|export|cleaned)\b[^.?!]*\b(?:excel|spreadsheet|xlsx|workbook)\b/i.test(lower) ||
    /\b(?:as|in|into)\s+(?:an?\s+)?(?:excel\s+(?:file|sheet|spreadsheet|workbook)?|xlsx\s+file|xlsx)\b/i.test(lower);
  const hasXlsx = deliverables.some((f) => f.toLowerCase().endsWith(".xlsx"));
  if (requestsXlsx && !hasXlsx) {
    let name = "workbook.xlsx";
    if (/\bcleaned\b/i.test(lower)) name = "cleaned.xlsx";
    else if (/\bsupporting\b/i.test(lower)) name = "supporting-workbook.xlsx";
    deliverables.push(name);
  }

  // C. CSV export
  const requestsCsv =
    /\b(?:export|save|generate|create)\b[^.?!]*\b(?:to\s+csv|as\s+csv|csv\s+file|csv\s+export)\b/i.test(lower);
  const hasCsv = deliverables.some((f) => f.toLowerCase().endsWith(".csv"));
  if (requestsCsv && !hasCsv) {
    deliverables.push("export.csv");
  }

  return deliverables;
}

/**
 * Detects whether the user is requesting workspace filesystem mutations
 * (modifying, patching, creating, deleting files in the project workspace).
 */
export function detectWorkspaceMutation(
  userPrompt: string,
  hasWorkspace: boolean,
  workspaceFiles: string[] = [],
  inputFiles: string[] = [],
): { requested: boolean; files: string[] } {
  const lower = userPrompt.toLowerCase();
  const mutFiles: string[] = [];

  // Pure informational inquiry never mutates workspace files
  if (isInformationalInquiry(userPrompt)) {
    return { requested: false, files: [] };
  }

  // Action verbs indicating code modification or file writes
  const hasMutationVerb =
    /\b(setup|set up|setting up|create|creates|created|creating|build|builds|built|building|init|initialize|initializes|initialized|update|updates|updated|modify|modifies|modified|edit|edits|edited|patch|patches|patched|refactor|refactors|refactored|fix|fixes|fixed|repair|repairs|repaired|rewrite|rewrites|rewrote|delete|deletes|deleted|remove|removes|removed|add|adds|added|scaffold|scaffolds|convert|converts|converted|migrate|migrates|migrated|implement|implements|implemented)\b/i.test(
      lower,
    );

  // Match target workspace filenames in the prompt (e.g. "config.json", "server.py")
  const fileRegex = /\b([a-zA-Z0-9_\-./\\]+\.(?:json|js|ts|jsx|tsx|py|html|css|yaml|yml|sh|toml|ini|env))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(userPrompt)) !== null) {
    const raw = match[1];
    const start = match.index;
    const preceding = userPrompt.slice(Math.max(0, start - 30), start).toLowerCase();

    // Skip if preceded by inquiry/inspection keywords
    if (/\b(?:from|inspect|read|parse|examine|using|check|explain|about)\s+(?:a\s+|an\s+|the\s+)?$/i.test(preceding)) {
      continue;
    }

    if (hasMutationVerb || /\b(?:to|in|into|for)\s+[`'"]?$/i.test(preceding)) {
      if (!mutFiles.includes(raw)) mutFiles.push(raw);
    }
  }

  // Match existing workspace files mentioned in conjunction with mutation verbs
  for (const wf of workspaceFiles) {
    const base = path.basename(wf);
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(`\\b${escapedBase}\\b`, "i");
    if (rx.test(lower) && hasMutationVerb && !mutFiles.includes(base) && !mutFiles.includes(wf)) {
      mutFiles.push(base);
    }
  }

  // Project-wide mutation requests (e.g. "Convert codebase to TypeScript", "Refactor authentication", "Setup an express app in workspace")
  const isProjectMutation =
    (hasWorkspace || mutFiles.length > 0 || /\b(?:workspace|directory|folder|repo|project|codebase)\b/i.test(lower)) &&
    hasMutationVerb &&
    (/\b(?:codebase|project|repo|repository|workspace|all files|middleware|server|routes|components|app|application|express|fastapi)\b/i.test(lower) ||
      mutFiles.length > 0);

  const requested = isProjectMutation || (mutFiles.length > 0 && (hasWorkspace || /\b(?:workspace|disk|directory|folder)\b/i.test(lower)));

  return { requested, files: mutFiles };
}

/**
 * Evaluates the user's request and runtime environment to derive an OutputExpectation record.
 * This represents user intent (chat response, expected deliverable files, workspace mutations)
 * without granting execution permissions.
 */
export function determineOutputExpectation(
  userPrompt: string,
  options: DetermineOutputExpectationOptions = {},
): OutputExpectation {
  const {
    attachments = [],
    hasWorkspace = false,
    workspaceFiles = [],
    semanticIntent,
  } = options;

  const inputFilenames = [
    ...attachments.map((a) => a.filename).filter(Boolean),
    ...(semanticIntent?.targetFiles ?? []),
  ] as string[];

  // 1. Is this an informational inquiry or conceptual explanation?
  const isExplanation = isInformationalInquiry(userPrompt);

  // If pure explanation/inquiry, no files expected and no workspace mutation requested
  if (isExplanation) {
    return {
      chatResponse: true,
      expectedFiles: [],
      workspaceMutationRequested: false,
    };
  }

  // 2. Deliverable expectations (Word, Excel, CSV reports)
  const deliverables = detectDeliverableExpectations(userPrompt, inputFilenames);

  // 3. Workspace mutation expectations
  const { requested: mutationRequested, files: mutatedFiles } = detectWorkspaceMutation(
    userPrompt,
    hasWorkspace,
    workspaceFiles,
    inputFilenames,
  );

  const isSemanticCodeMod =
    semanticIntent?.intentType === "code_modification" && semanticIntent?.isActionable === true;
  const effectiveMutationRequested = mutationRequested || Boolean(isSemanticCodeMod);

  // Combine expected files: deliverables + workspace files targeted for mutation
  const expectedFiles: string[] = [];
  for (const f of deliverables) {
    if (!expectedFiles.includes(f)) expectedFiles.push(f);
  }
  if (effectiveMutationRequested) {
    for (const f of mutatedFiles) {
      if (!expectedFiles.includes(f)) expectedFiles.push(f);
    }
  }

  return {
    chatResponse: true,
    expectedFiles,
    workspaceMutationRequested: effectiveMutationRequested,
  };
}
