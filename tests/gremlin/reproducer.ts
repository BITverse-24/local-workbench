import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExecutionRecord } from "../recorder.js";
import { confirmedChecks, findingFingerprint } from "../findings.js";
import { runScenario, type RunOptions } from "../runner.js";
import { scenarioSchema } from "../scenarios/schema.js";
import type { CampaignEffort } from "./effort.js";

function shrinkContext(text: string, prefix: string, suffix = ""): string | undefined {
  const start = text.indexOf(prefix);
  if (start < 0) return;
  const contentStart = start + prefix.length;
  const end = suffix ? text.lastIndexOf(suffix) : text.length;
  if (end < contentStart + 40) return;
  const content = text.slice(contentStart, end);
  return text.slice(0, contentStart) + content.slice(0, Math.floor(content.length / 2)) + text.slice(end);
}
function shrinkAddedContext(record: ExecutionRecord): ExecutionRecord["scenario"] | undefined {
  const candidate = structuredClone(record.scenario);
  for (const action of candidate.actions) if (action.type === "send") {
    const changed = shrinkContext(action.text, "Additional background (may be unreliable):\n", "\n\nBinding user requirements:\n")
      ?? shrinkContext(action.text, "Additional context: ", "\n\nOriginal binding requirements remain: ");
    if (changed) { action.text = changed; return candidate; }
  }
  for (const file of [...candidate.setup.attachments, ...candidate.setup.knowledgeBase, ...candidate.setup.workspace]) {
    const changed = shrinkContext(file.content, "\n\nEmbedded untrusted note:\n");
    if (changed) { file.content = changed; return candidate; }
  }
}
export async function reproduceAndMinimize(original: ExecutionRecord, options: RunOptions, effort: CampaignEffort, execute: typeof runScenario = runScenario): Promise<{ attempts: ExecutionRecord[]; minimized: ExecutionRecord; complete: boolean }> {
  const attempts = [original];
  const fingerprint = findingFingerprint(original);
  for (let n = 0; n < 3 && effort.available(true) && !options.signal?.aborted; n++) {
    effort.take(true);
    attempts.push(await execute({ ...original.scenario, deadlineMs: Math.max(1, Math.min(original.scenario.deadlineMs, effort.remainingMs())) }, options));
  }
  let minimized = original;
  const minimizationTrials: ExecutionRecord[] = [];
  // Minimize added context, preserving all original binding requirements and checks.
  for (let n = 0; n < 5 && effort.available(true) && !options.signal?.aborted; n++) {
    const candidate = shrinkAddedContext(minimized);
    if (!candidate) break;
    effort.take(true);
    const result = await execute(scenarioSchema.parse({ ...candidate, deadlineMs: Math.max(1, Math.min(candidate.deadlineMs, effort.remainingMs())) }), options);
    minimizationTrials.push(result);
    if (!confirmedChecks(result).length || findingFingerprint(result) !== fingerprint) break;
    minimized = result;
  }
  const complete = attempts.length === 4 && !attempts.some((r) => r.interrupted);
  writeFileSync(path.join(original.evidenceDir, "reproduction.json"), JSON.stringify({ targetMode: options.mode, originalExecution: original.executionId, originalFailures: attempts.filter((r) => confirmedChecks(r).length && findingFingerprint(r) === fingerprint).length, originalAttempts: attempts.length, complete, minimizedExecution: minimized.executionId, attempts: attempts.map((r) => r.evidenceDir), minimizationTrials: minimizationTrials.map((r) => ({ executionId: r.executionId, evidence: r.evidenceDir, retainsFailure: confirmedChecks(r).length > 0 && findingFingerprint(r) === fingerprint })) }, null, 2));
  return { attempts, minimized, complete };
}
