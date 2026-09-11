import type { ModelId, TaskType } from "../../shared/contracts.js";

export type ActionTarget = "harness" | "data" | "vision" | "chat" | "standalone_file";

export interface IntentDecision {
  taskType: TaskType;
  modelId: ModelId;
  actionTarget: ActionTarget;
  reason: string;
  isWorkspaceAction: boolean;
  isNegativeWorkspaceConstraint?: boolean;
  extractedFilename?: string;
  suggestedExtension?: string;
  confidence?: number;
}

export interface ClassifyIntentInput {
  userText: string;
  attachment?: { mediaType: string; filename?: string };
  isWorkspaceActive?: boolean;
}

// ── Action Verbs & Noun Categories ──────────────────────────────────────

const FILE_ACTION_VERBS =
  /\b(create|write|save|make|add|generate|gen|edit|modify|update|touch|delete|remove|append|produce|build|draft|output|export|dump|render|prepare|put|place)\b/i;

const FILE_CONTAINER_NOUNS =
  /\b(file|files|txt file|archive)\b/i;

const REFERENTIAL_DELIVERABLE_NOUNS =
  /\b(it|this|that|artifact|artefact|document|deliverable|output|note|draft|script|report)\b/i;

const REFERENTIAL_FOLLOWUP_PATTERN =
  /\b(the artifact|the artefact|the deliverable|earlier|previous artifact|just generated|which you just|generated earlier)\b/i;

const DRAFTING_INTENT_PATTERNS =
  /\b(approval note|draft (?:an? )?(?:note|memo|letter|report|document|brief|summary|proposal)|write (?:an? )?(?:approval note|memo|formal note|letter|recommendation)|nuclear reactor shutdown|maintenance shutdown|word document|\.docx|docx\b|executive summary|formal note|compliance note|clearance note|incident report|briefing note)\b/i;

const WORKSPACE_CONTAINER_NOUNS =
  /\b(workspace|directory|dir|folder|codebase|repo|repository|project|disk|filesystem|cwd|root|ws)\b/i;

const FILE_EXTENSION_PATTERN =
  /\b[a-zA-Z0-9_\-.]+\.(txt|js|ts|jsx|tsx|json|md|py|csv|html|css|yaml|yml|sh|env|sql|xml|rs|go|java|c|cpp|h|toml|ini)\b/i;

const EXPLICIT_FILENAME_PATTERN =
  /\b([a-zA-Z0-9_\-]+\.(?:txt|js|ts|jsx|tsx|json|md|py|csv|html|css|yaml|yml|sh|env|sql|xml|rs|go|java|c|cpp|h|toml|ini))\b/i;

const DIRECTORY_CONTEXT_PHRASES =
  /\b(?:in|into|to|inside|within)\s+(?:the\s+|this\s+|my\s+)?(?:directory|folder|dir|workspace|project|repo|repository|codebase|root|ws)\b/i;

const PROJECT_PATH_SYNTAX =
  /(?:^|\s)(?:\.\/|\.\.\/|src\/|tests?\/|lib\/|app\/|pkg\/|scripts\/|config\/)[a-zA-Z0-9_\-./]+/i;

// ── Language-to-Extension Map ───────────────────────────────────────────

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  python: "py",
  py: "py",
  typescript: "ts",
  ts: "ts",
  javascript: "js",
  js: "js",
  json: "json",
  html: "html",
  css: "css",
  markdown: "md",
  md: "md",
  text: "txt",
  txt: "txt",
  csv: "csv",
  sql: "sql",
  shell: "sh",
  bash: "sh",
  sh: "sh",
  yaml: "yaml",
  yml: "yaml",
  rust: "rs",
  rs: "rs",
  golang: "go",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
};

const COMMAND_ACTION_VERBS = /\b(run|execute|test|build|compile|install|start|deploy)\b/i;
const COMMAND_TARGET_NOUNS = /\b(command|cmd|terminal|shell|test suite|npm|pnpm|yarn|pip|git|pytest|vitest|cargo|make)\b/i;

const EXPLORATION_PHRASES = /\b(list\s+files|show\s+files|browse\s+(?:directory|folder|repo|workspace)|search\s+in\s+(?:codebase|files|project|repo)|find\s+in\s+files|view\s+files|tree)\b/i;

const DATA_ANALYSIS_KEYWORDS = /\b(csv|calculation|calculate|dataset|rows|columns|data\s+transformation|out-of-range|summary\s+statistics|aggregat(?:e|ion)|sum|average|mean|median)\b/i;

// ── Token Proximity & Fuzzy Matching Helpers ────────────────────────────

const NEGATOR_WORDS = [
  "not", "no", "dont", "never", "without", "avoid", "skip", "refrain",
  "exclude", "cant", "wont", "non", "stop", "prevent", "omit", "disallow",
];

const WORKSPACE_TARGET_WORDS = [
  "workspace", "ws", "directory", "dir", "dirs", "folder", "repo",
  "repository", "codebase", "project", "disk", "filesystem", "root", "cwd",
];

const SAVE_ACTION_WORDS = [
  "save", "saving", "write", "writing", "put", "putting", "store", "storing",
  "create", "creating", "commit", "committing", "touch", "touching", "dump",
  "dumping", "place", "placing", "persist", "persisting", "drop", "dropping",
  "keep", "keeping", "gen", "generate", "generating",
];

const STANDALONE_WORDS = [
  "artifact", "artefact", "standalone", "isolated", "sandbox", "scratch",
  "temp", "temporary", "downloadable", "deliverable", "preview",
];

/**
 * Normalizes user text into clean tokens, expanding common contractions & shorthands.
 */
function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "") // don't -> dont
    .replace(/\bw\/o\b/g, "without")
    .replace(/\bw\/\b/g, "with")
    .replace(/[^a-z0-9_.\-\/]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Fast Levenshtein distance for typo-tolerant matching.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

/**
 * Fuzzy check matching exact words, stems, or small typo distances.
 */
function fuzzyMatches(token: string, targetWords: string[]): boolean {
  for (const target of targetWords) {
    if (token === target) return true;
    if (token.startsWith(target) || target.startsWith(token)) {
      if (Math.min(token.length, target.length) >= 4) return true;
    }
    const maxAllowed = target.length >= 8 ? 2 : target.length >= 5 ? 1 : 0;
    if (maxAllowed > 0 && Math.abs(token.length - target.length) <= maxAllowed) {
      if (editDistance(token, target) <= maxAllowed) return true;
    }
  }
  return false;
}

/**
 * Windowed token proximity search to detect negative workspace constraints.
 * Detects phrases like "dont save in ws", "no save workspace", "not in repo",
 * "skip workspace", "w/o disk", "outside ws", and handles typos like "workpsace".
 */
function detectNegativeWorkspaceConstraint(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Case 1: "outside" within 3 tokens of a workspace target
    if (token === "outside") {
      for (let j = i + 1; j <= Math.min(i + 3, tokens.length - 1); j++) {
        if (fuzzyMatches(tokens[j], WORKSPACE_TARGET_WORDS)) return true;
      }
    }

    // Case 2: Negator token within 5 tokens of a workspace target
    if (fuzzyMatches(token, NEGATOR_WORDS)) {
      for (let j = i + 1; j <= Math.min(i + 5, tokens.length - 1); j++) {
        if (fuzzyMatches(tokens[j], WORKSPACE_TARGET_WORDS)) {
          // Verify that between the negator and workspace target, there is an action verb, preposition, or direct adjacency
          const intermediate = tokens.slice(i + 1, j);
          const hasSaveAction = intermediate.some((t) => fuzzyMatches(t, SAVE_ACTION_WORDS));
          const hasPreposition = intermediate.some((t) => ["in", "to", "into", "on", "at", "my", "the", "this"].includes(t));
          if (intermediate.length === 0 || hasSaveAction || hasPreposition) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Detect standalone deliverable indicators (typo-tolerant, word-skip tolerant).
 * Matches "artifact", "artefact", "artifct", "standalone", "scratch", "temp", "chat only", etc.
 */
function detectStandaloneHint(tokens: string[], rawText: string): boolean {
  // 1. Any fuzzy token match (e.g. "artifct", "artefact", "standalone", "temp", "scratch")
  for (const token of tokens) {
    if (fuzzyMatches(token, STANDALONE_WORDS)) return true;
  }

  // 2. Chat-only or preview-only intent
  if (/\b(?:just|only|directly)\s+(?:in|as|via)\s+(?:chat|preview|download|output)\b/i.test(rawText)) {
    return true;
  }
  if (/\b(?:in|to|into)\s+chat\s+only\b/i.test(rawText) || /\bchat\s+only\b/i.test(rawText)) {
    return true;
  }

  // 3. Explicit "outside workspace"
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "outside") {
      for (let j = i + 1; j <= Math.min(i + 3, tokens.length - 1); j++) {
        if (fuzzyMatches(tokens[j], WORKSPACE_TARGET_WORDS)) return true;
      }
    }
  }

  return false;
}

/**
 * Infer file extension from language mentions in text (e.g. "python file", "py script" -> "py").
 */
function inferLanguageExtension(text: string): string | undefined {
  const match = text.match(/\b(python|py|typescript|ts|javascript|js|json|html|css|markdown|md|text|txt|csv|sql|shell|bash|sh|rust|rs|golang|go|java|cpp)\b/i);
  if (!match) return undefined;
  return LANGUAGE_EXTENSIONS[match[1].toLowerCase()];
}

/**
 * Intelligent, 0ms Deterministic Intent Classifier & Evidence Scoring Engine.
 *
 * Evaluates environment state (active workspace), attached media (PDF/images/CSV),
 * syntactic patterns, negative constraints, and isolation indicators to select the exact execution target:
 * - "standalone_file": File deliverable generated in run artifacts, kept isolated from workspace disk.
 * - "harness": Workspace harness loop with real filesystem & command tools.
 * - "data": Sandboxed Python data runner (CSV or tabular data).
 * - "vision": Multi-modal document/image analysis.
 * - "chat": Conversational assistant with markdown formatting.
 */
export function classifyIntent(input: ClassifyIntentInput): IntentDecision {
  const { userText, attachment, isWorkspaceActive = false } = input;
  const lower = userText.toLowerCase();

  // 1. Vision Intent (Absolute precedence when media attached)
  if (attachment && (attachment.mediaType === "application/pdf" || attachment.mediaType.startsWith("image/"))) {
    return {
      taskType: "vision",
      modelId: "vision-qwen25vl",
      actionTarget: "vision",
      reason: "scanned report",
      isWorkspaceAction: false,
      confidence: 1.0,
    };
  }

  // 2. Data Intent (CSV attachment or explicit CSV/data processing with attachment)
  if (
    attachment?.mediaType === "text/csv" ||
    (attachment && DATA_ANALYSIS_KEYWORDS.test(lower))
  ) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      actionTarget: "data",
      reason: "CSV/code intent",
      isWorkspaceAction: false,
      confidence: 0.95,
    };
  }

  // 2.5. Approval Note & Document Drafting Intent (routes to draft model draft-qwen3)
  if (DRAFTING_INTENT_PATTERNS.test(userText)) {
    return {
      taskType: "draft",
      modelId: "draft-qwen3",
      actionTarget: "chat",
      reason: "approval note drafting",
      isWorkspaceAction: false,
      confidence: 0.95,
    };
  }

  // 3. Extract Syntactic and Semantic Features
  const tokens = normalizeTokens(userText);
  const hasNegativeWorkspaceConstraint = detectNegativeWorkspaceConstraint(tokens);
  const hasStandaloneHint = detectStandaloneHint(tokens, userText);
  const hasFileActionVerb = FILE_ACTION_VERBS.test(lower);
  const hasFileContainerNoun = FILE_CONTAINER_NOUNS.test(lower);
  const hasWorkspaceNoun = WORKSPACE_CONTAINER_NOUNS.test(lower);
  const hasFileExtension = FILE_EXTENSION_PATTERN.test(lower);
  const hasDirectoryContext = DIRECTORY_CONTEXT_PHRASES.test(lower);
  const hasProjectPath = PROJECT_PATH_SYNTAX.test(userText);
  const suggestedExtension = inferLanguageExtension(userText);

  // Extract explicit filename if present
  const filenameMatch = userText.match(EXPLICIT_FILENAME_PATTERN);
  const extractedFilename = filenameMatch ? filenameMatch[1] : undefined;

  const hasCommandAction =
    COMMAND_ACTION_VERBS.test(lower) && (COMMAND_TARGET_NOUNS.test(lower) || hasDirectoryContext);

  const hasExplorationAction = EXPLORATION_PHRASES.test(lower);

  // 4. Evidence-Based Scoring System
  let scoreHarness = 0;
  let scoreStandalone = 0;
  let scoreData = 0;
  let scoreChat = 10; // Default baseline

  const hasReferentialNoun = REFERENTIAL_DELIVERABLE_NOUNS.test(lower);

  // File creation intent
  const isFileCreationRequest =
    (hasFileActionVerb && (hasFileContainerNoun || hasReferentialNoun || hasFileExtension || suggestedExtension !== undefined)) ||
    hasFileExtension;

  if (isFileCreationRequest) {
    if (hasNegativeWorkspaceConstraint || hasStandaloneHint) {
      scoreStandalone += 80;
      scoreHarness -= 100; // Heavily penalize workspace modification
    } else if (hasDirectoryContext || hasProjectPath) {
      scoreHarness += 50;
      scoreStandalone += 10;
    } else if (isWorkspaceActive) {
      scoreHarness += 40;
      scoreStandalone += 20;
    } else {
      scoreHarness += 35;
      scoreStandalone += 25;
    }
  }

  // Follow-up referring to previous chat deliverable/artifact
  if (REFERENTIAL_FOLLOWUP_PATTERN.test(lower)) {
    if (hasNegativeWorkspaceConstraint || hasStandaloneHint) {
      scoreStandalone += 70;
      scoreHarness -= 100;
    } else if (isWorkspaceActive) {
      scoreHarness += 45;
      scoreStandalone += 15;
    } else {
      scoreStandalone += 40;
    }
  }

  // Exploration & Command actions
  if (hasExplorationAction) {
    scoreHarness += 60;
  }
  if (hasCommandAction) {
    scoreHarness += 60;
  }

  // Active workspace inquiry (e.g. codebase search, bug explanation)
  if (isWorkspaceActive && /\b(codebase|files|function|class|bug|error|refactor|fix|how does|where is)\b/i.test(lower)) {
    scoreHarness += 30;
  }

  // Data processing without attachment
  if (DATA_ANALYSIS_KEYWORDS.test(lower)) {
    scoreData += 15;
  }

  // 5. Intent Decision Resolution
  // Case A: Explicit standalone file requested OR negative workspace constraint
  if (hasNegativeWorkspaceConstraint || (hasStandaloneHint && isFileCreationRequest)) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      actionTarget: "standalone_file",
      reason: hasNegativeWorkspaceConstraint
        ? "standalone file creation (negative workspace constraint)"
        : "standalone file creation (isolated from workspace)",
      isWorkspaceAction: false,
      isNegativeWorkspaceConstraint: hasNegativeWorkspaceConstraint,
      extractedFilename,
      suggestedExtension,
      confidence: 0.95,
    };
  }

  // Case B: Workspace harness execution
  const isWorkspaceFileOp =
    (hasFileActionVerb && (hasFileContainerNoun || hasFileExtension || hasDirectoryContext)) ||
    hasDirectoryContext ||
    hasFileExtension;

  if (scoreHarness > scoreChat && (isWorkspaceFileOp || hasCommandAction || hasExplorationAction || (isWorkspaceActive && scoreHarness >= 30))) {
    return {
      taskType: "code",
      modelId: "code-qwen25coder",
      actionTarget: "harness",
      reason: isWorkspaceFileOp
        ? "workspace file modification"
        : hasCommandAction
        ? "workspace command execution"
        : hasExplorationAction
        ? "workspace exploration"
        : "active workspace code inquiry",
      isWorkspaceAction: true,
      extractedFilename,
      suggestedExtension,
      confidence: 0.9,
    };
  }

  // Case C: Fallback to conversational assistant
  return {
    taskType: "draft",
    modelId: "draft-qwen3",
    actionTarget: "chat",
    reason: "fallback drafting",
    isWorkspaceAction: false,
    confidence: 0.8,
  };
}
