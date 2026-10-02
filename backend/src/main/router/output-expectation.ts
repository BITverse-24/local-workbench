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
 * Extracts filenames that are explicitly subject to negative constraints in the user prompt
 * (e.g. "do not modify config.json, unrelated.md", "leave notes.txt untouched", "except server.ts").
 */
export function extractNegativeFileConstraints(userPrompt: string): Set<string> {
  const negatedFiles = new Set<string>();
  if (!userPrompt) return negatedFiles;

  // Split into sentences and clauses by punctuation and contrastive conjunctions
  const clauses = userPrompt.split(/(?:(?:\.|\?|!|;|\n)['"”)]*(?:\s+|$))|,\s*(?=(?:but|however|except|without|excluding|while)\b)/i);

  const NEGATIVE_DIRECTIVE_REGEX =
    /\b(?:do\s*n['o]?t|never|should\s*n['o]?t|must\s*n['o]?t|cannot|can['o]?t|won['o]?t)\s+(?:modify|touch|change|edit|update|delete|remove|overwrite|create|write|alter|mutate|affect|save|run)\b|\bwithout\s+(?:modifying|touching|changing|editing|updating|deleting|removing|overwriting|creating|writing|altering)\b|\b(?:except(?:\s+for)?|excluding|exclude|skip|ignore)\b|\b(?:no\s+(?:changes?|modifications?|edits?|updates?)\s+to)\b|\b(?:not\s+(?:to\s+)?(?:modify|touch|change|edit|update|delete|remove|overwrite|create|write))\b/i;

  const FILE_REGEX = /\b([a-zA-Z0-9_.-]+(?:\/|\\)[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)\b/g;
  const LEAVE_REGEX = /\bleave\s+([a-zA-Z0-9_.-]+(?:\/|\\)[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+)\s+(?:untouched|alone|as[\s-]is|unchanged)\b/i;

  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;

    const negMatch = NEGATIVE_DIRECTIVE_REGEX.exec(trimmed);
    if (negMatch) {
      const directiveEnd = negMatch.index + negMatch[0].length;
      const afterText = trimmed.slice(directiveEnd);
      let fMatch: RegExpExecArray | null;
      FILE_REGEX.lastIndex = 0;
      while ((fMatch = FILE_REGEX.exec(afterText)) !== null) {
        const rawFilename = fMatch[1].trim();
        const base = path.basename(rawFilename);
        if (base && !base.startsWith(".")) {
          negatedFiles.add(rawFilename.toLowerCase());
          negatedFiles.add(base.toLowerCase());
        }
      }
    }

    const leaveMatch = LEAVE_REGEX.exec(trimmed);
    if (leaveMatch && leaveMatch[1]) {
      const rawFilename = leaveMatch[1].trim();
      const base = path.basename(rawFilename);
      if (base && !base.startsWith(".")) {
        negatedFiles.add(rawFilename.toLowerCase());
        negatedFiles.add(base.toLowerCase());
      }
    }
  }

  return negatedFiles;
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
  const negatedFiles = extractNegativeFileConstraints(userPrompt);

  // 1. Detect explicit deliverable filenames in prompt (e.g. "report.docx", "cleaned.xlsx", "output.csv")
  const fileRegex = /\b([a-zA-Z0-9_\-.]+\.(?:docx|xlsx|csv|pdf|md))\b/gi;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(userPrompt)) !== null) {
    const raw = match[1];
    const rawLower = raw.toLowerCase();
    if (lowerInputs.has(rawLower)) continue;
    if (negatedFiles.has(rawLower) || negatedFiles.has(path.basename(rawLower))) continue;

    const start = match.index;
    const preceding = userPrompt.slice(Math.max(0, start - 30), start).toLowerCase();

    // Skip if preceded by read/inspect/from keywords or negative directives
    if (/\b(?:from|inspect|read|parse|examine|using|check|input|about|explain)\s+(?:a\s+|an\s+|the\s+)?$/i.test(preceding)) {
      continue;
    }
    if (/\b(?:not\s+modify|not\s+touch|not\s+change|not\s+create|do\s*n['o]?t|never|exclude|except)\b/i.test(preceding)) {
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
    !negatedFiles.has("approval-note.docx") &&
    !negatedFiles.has("report.docx") &&
    !/\b(?:do\s*n['o]?t|never)\s+(?:draft|generate|create)\s+(?:a\s+)?(?:word|docx|report|approval\s+note)\b/i.test(userPrompt) &&
    (/\b(?:draft|generate|create|produce|compile|export)\b[^.?!]*\b(?:approval\s+note|compliance\s+note|word\s+doc(?:ument)?|docx|formal\s+note|report)\b/i.test(lower) ||
    /\b(?:as|in|into)\s+(?:a\s+)?(?:word\s+document|docx\s+file|docx)\b/i.test(lower));
  const hasDocx = deliverables.some((f) => f.toLowerCase().endsWith(".docx"));
  if (requestsDocx && !hasDocx) {
    const name = /\breport\b/i.test(lower) ? "report.docx" : "approval-note.docx";
    if (!negatedFiles.has(name)) deliverables.push(name);
  }

  // B. XLSX / Excel spreadsheet / Workbook
  const requestsXlsx =
    !negatedFiles.has("workbook.xlsx") &&
    !negatedFiles.has("cleaned.xlsx") &&
    !/\b(?:do\s*n['o]?t|never)\s+(?:generate|create|produce)\s+(?:a\s+)?(?:excel|spreadsheet|xlsx|workbook)\b/i.test(userPrompt) &&
    (/\b(?:generate|create|produce|compile|export|cleaned)\b[^.?!]*\b(?:excel|spreadsheet|xlsx|workbook)\b/i.test(lower) ||
    /\b(?:as|in|into)\s+(?:an?\s+)?(?:excel\s+(?:file|sheet|spreadsheet|workbook)?|xlsx\s+file|xlsx)\b/i.test(lower));
  const hasXlsx = deliverables.some((f) => f.toLowerCase().endsWith(".xlsx"));
  if (requestsXlsx && !hasXlsx) {
    let name = "workbook.xlsx";
    if (/\bcleaned\b/i.test(lower)) name = "cleaned.xlsx";
    else if (/\bsupporting\b/i.test(lower)) name = "supporting-workbook.xlsx";
    if (!negatedFiles.has(name)) deliverables.push(name);
  }

  // C. CSV export
  const requestsCsv =
    !negatedFiles.has("export.csv") &&
    !/\b(?:do\s*n['o]?t|never)\s+(?:export|save|generate)\s+(?:to\s+csv|as\s+csv|csv)\b/i.test(userPrompt) &&
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
  const negatedFiles = extractNegativeFileConstraints(userPrompt);

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
    const rawLower = raw.toLowerCase();
    if (negatedFiles.has(rawLower) || negatedFiles.has(path.basename(rawLower))) continue;

    const start = match.index;
    const preceding = userPrompt.slice(Math.max(0, start - 30), start).toLowerCase();

    // Skip if preceded by inquiry/inspection keywords or negative directives
    if (/\b(?:from|inspect|read|parse|examine|using|check|explain|about)\s+(?:a\s+|an\s+|the\s+)?$/i.test(preceding)) {
      continue;
    }
    if (/\b(?:not\s+modify|not\s+touch|not\s+change|not\s+edit|do\s*n['o]?t|never|exclude|except)\b/i.test(preceding)) {
      continue;
    }

    if (hasMutationVerb || /\b(?:to|in|into|for)\s+[`'"]?$/i.test(preceding)) {
      if (!mutFiles.includes(raw)) mutFiles.push(raw);
    }
  }

  // Match existing workspace files mentioned in conjunction with mutation verbs
  for (const wf of workspaceFiles) {
    const base = path.basename(wf);
    if (negatedFiles.has(base.toLowerCase()) || negatedFiles.has(wf.toLowerCase())) continue;
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
 * Derives runtime output expectations directly from a validated semantic intent record
 * without reinterpreting the user's natural language request via regex.
 */
export function deriveOutputExpectation(intent: Partial<SemanticIntent>): OutputExpectation {
  const deliverableFiles = (intent.expectedDeliverables ?? [])
    .map((d) => d.filename)
    .filter(Boolean) as string[];

  const isMutation =
    intent.workspaceMutationRequested ??
    (intent.intentType === "code_modification" && intent.isActionable === true);

  return {
    chatResponse: true,
    expectedFiles: deliverableFiles,
    workspaceMutationRequested: Boolean(isMutation),
    targetFiles: intent.targetFiles ?? [],
    expectedDeliverables: intent.expectedDeliverables ?? [],
    protectedPaths: intent.protectedPaths ?? [],
    restrictMutationsToTargets: Boolean(intent.restrictMutationsToTargets),
  };
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

  // If a validated semantic intent is provided, derive expectations directly without regex
  if (semanticIntent && semanticIntent.status === "resolved") {
    return deriveOutputExpectation(semanticIntent);
  }

  const inputFilenames = [
    ...attachments.map((a) => a.filename).filter(Boolean),
  ] as string[];

  // 1. Is this an informational inquiry or conceptual explanation?
  const isExplanation = isInformationalInquiry(userPrompt);

  // If pure explanation/inquiry, no files expected and no workspace mutation requested
  if (isExplanation) {
    return {
      chatResponse: true,
      expectedFiles: [],
      workspaceMutationRequested: false,
      targetFiles: [],
      expectedDeliverables: [],
      protectedPaths: [],
      restrictMutationsToTargets: false,
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

  const effectiveMutationRequested = mutationRequested;

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

  const negated = extractNegativeFileConstraints(userPrompt);

  return {
    chatResponse: true,
    expectedFiles,
    workspaceMutationRequested: effectiveMutationRequested,
    targetFiles: mutatedFiles,
    protectedPaths: Array.from(negated),
    restrictMutationsToTargets: false,
  };
}
