import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluateOracles } from "./oracles.js";
import { hasTool, manifest, materialize, sha256 } from "./sandbox.js";
import type { FileMap, OracleResult, RunObservation, TaskFamily, TaskInstance } from "./task-spec.js";

const bytes = (v: string | Uint8Array): Uint8Array => (typeof v === "string" ? Buffer.from(v, "utf8") : v);

export function instanceDigest(task: TaskInstance): string {
  return sha256(JSON.stringify(task, (_k, v) => (v instanceof Uint8Array ? `bytes:${sha256(v)}` : v)));
}

export interface SelfCheckResult {
  id: string;
  ok: boolean;
  skipped?: string;
  problems: string[];
  pristine: OracleResult[];
  reference: OracleResult[];
}

function toArtifacts(files: FileMap | undefined) {
  return Object.entries(files ?? {}).map(([filename, content]) => ({ filename: path.basename(filename), bytes: bytes(content) }));
}

function leaks(task: TaskInstance): string[] {
  const problems: string[] = [];
  const visible = [task.prompt, ...Object.values(task.workspace ?? {}).map((v) => (typeof v === "string" ? v : "")), ...Object.values(task.attachments ?? {}).map((v) => (typeof v === "string" ? v : ""))].join("\n");
  for (const [file, content] of Object.entries(task.hidden ?? {})) {
    if (task.workspace && file in task.workspace) problems.push(`hidden file ${file} is also visible in the workspace`);
    if (typeof content === "string" && content.length > 40 && visible.includes(content.slice(0, 200))) problems.push(`hidden file ${file} content appears in visible inputs`);
  }
  const allowed = new Set((task.promptLiterals ?? []).map((s) => s.toLowerCase()));
  const prompt = task.prompt.toLowerCase();
  for (const oracle of task.oracles) {
    const literals: string[] = [];
    if (oracle.type === "deliverable") {
      for (const f of oracle.facts) {
        if (f.kind === "contains") literals.push(f.value);
        if (f.kind === "row") for (const v of Object.values(f.expect)) if (typeof v === "string") literals.push(v);
      }
    }
    if (oracle.type === "claims") literals.push(...(oracle.mustNotContain ?? []));
    for (const lit of literals) {
      if (lit.length >= 4 && !allowed.has(lit.toLowerCase()) && prompt.includes(lit.toLowerCase())) problems.push(`prompt contains oracle value "${lit}"`);
    }
  }
  return problems;
}

/** Model-free validation: the task fails untouched, passes with its reference solution, is deterministic and leak-free. */
export async function selfCheck(family: TaskFamily, seed: number): Promise<SelfCheckResult> {
  const task = await family.generate(seed);
  const problems: string[] = [];
  const again = await family.generate(seed);
  if (instanceDigest(task) !== instanceDigest(again)) problems.push("generation is not deterministic for this seed");
  problems.push(...leaks(task));
  const missing = (task.requires ?? []).filter((tool) => !hasTool(tool));
  if (missing.length) return { id: task.id, ok: true, skipped: `missing toolchain: ${missing.join(", ")}`, problems, pristine: [], reference: [] };

  const scratch = mkdtempSync(path.join(tmpdir(), "eval-selfcheck-"));
  try {
    const pristineRoot = path.join(scratch, "pristine");
    materialize(pristineRoot, task.workspace);
    const before = manifest(pristineRoot);
    const pristineObs: RunObservation = {
      workspaceRoot: pristineRoot,
      before,
      after: manifest(pristineRoot),
      // Worst case for a run that did nothing: it claims completion with no flag and no output.
      finalState: "completed",
      assistantText: "",
      artifacts: [],
      toolCalls: [],
    };
    const pristine = await evaluateOracles(task, pristineObs);
    if (pristine.every((r) => r.pass)) problems.push("every oracle passes on the untouched task (it is trivially satisfied)");

    const referenceRoot = path.join(scratch, "reference");
    materialize(referenceRoot, task.workspace);
    materialize(referenceRoot, task.reference.files);
    const reference = await evaluateOracles(task, {
      workspaceRoot: referenceRoot,
      before,
      after: manifest(referenceRoot),
      finalState: task.reference.finalState ?? "completed",
      assistantText: task.reference.assistantText ?? "",
      artifacts: toArtifacts(task.reference.artifacts),
      toolCalls: [],
    });
    for (const r of reference) if (!r.pass) problems.push(`reference solution fails ${r.id}: ${r.detail}`);
    return { id: task.id, ok: problems.length === 0, problems, pristine, reference };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
