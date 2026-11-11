export type FileMap = Record<string, string | Uint8Array>;

export type Tier = "smoke" | "core" | "hard" | "adversarial" | "heldout";
export type EvalMode = "agent" | "work";
export type Expectation = "complete" | "flag_or_partial";

export type Fact =
  | { kind: "contains"; value: string; caseSensitive?: boolean }
  | { kind: "regex"; pattern: string; flags?: string }
  | {
      /** Find the first row where every `where` column matches, then check `expect` columns. */
      kind: "row";
      where: Record<string, string>;
      expect: Record<string, string | { approx: number; tol: number }>;
    }
  | { kind: "rowCount"; count: number };

export type OracleSpec =
  /** Run a command in the final workspace after oracle-only (hidden) files are copied in. */
  | { type: "command"; command: string; timeoutMs?: number }
  /** Changed files must stay within `allow`; `protect` paths must be byte-identical. */
  | { type: "scope"; allow: string[]; protect?: string[]; requireChange?: boolean }
  /** Parse a deliverable (docx, xlsx, csv, json, md, txt) and assert exact facts. */
  | { type: "deliverable"; filename: string; facts: Fact[]; forbidden?: string[] }
  /** Final assistant text plus artifact text. */
  | { type: "claims"; mustNotContain?: string[]; mustFlag?: string[] }
  | { type: "outcome"; allowed: string[] }
  | { type: "forbidTools"; tools: string[] };

export interface ReferenceSolution {
  /** Files overlaid on the workspace (agent mode). */
  files?: FileMap;
  /** Deliverables produced (work mode). */
  artifacts?: FileMap;
  assistantText?: string;
  finalState?: string;
}

export interface TaskInstance {
  /** `family/seed`. */
  id: string;
  family: string;
  seed: number;
  tier: Tier;
  mode: EvalMode;
  prompt: string;
  /** Files visible to the model (agent workspace). */
  workspace?: FileMap;
  /** Work-mode attachments. */
  attachments?: FileMap;
  /** Knowledge-base documents (work mode). */
  knowledgeBase?: Record<string, string>;
  /** Oracle-only files. Never on disk while the model runs. */
  hidden?: FileMap;
  reference: ReferenceSolution;
  oracles: OracleSpec[];
  expectation: Expectation;
  limits: { timeoutMs: number };
  /** Literal strings allowed to appear in the prompt even though they are oracle values. */
  promptLiterals?: string[];
  /** Language/toolchain this task needs on the host (skip if missing). */
  requires?: string[];
}

export interface TaskFamily {
  id: string;
  tier: Tier;
  mode: EvalMode;
  description: string;
  generate(seed: number): Promise<TaskInstance> | TaskInstance;
  /** Seeds used for normal development runs. */
  devSeeds: number[];
}

export interface ToolCallObservation {
  tool: string;
  args?: unknown;
}

/** What a driver (or a self-check) hands to the oracles. */
export interface RunObservation {
  workspaceRoot?: string;
  before?: Map<string, string>;
  after?: Map<string, string>;
  finalState: string;
  assistantText: string;
  artifacts: Array<{ filename: string; bytes: Uint8Array }>;
  toolCalls: ToolCallObservation[];
}

export interface OracleResult {
  id: string;
  type: OracleSpec["type"];
  pass: boolean;
  detail: string;
}
