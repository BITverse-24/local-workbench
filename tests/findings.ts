import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./helpers/files.js";
import { redact, safeJSON } from "./helpers/redact.js";
import type { ExecutionRecord, CheckResult } from "./recorder.js";

export function confirmedChecks(record: ExecutionRecord): CheckResult[] {
  if (record.interrupted) return [];
  // Infrastructure failures and unsupported judge-only claims are never auto-filed.
  return record.results.filter((r) => r.verdict === "fail" && r.category !== "health" && (r.category === "policy" || (!record.healthError && r.category === "task")));
}
export function findingFingerprint(record: ExecutionRecord): string {
  const failures = confirmedChecks(record);
  const checkIds = new Set(failures.map((r) => r.id));
  const expectedPaths = record.scenario.checks.filter((c) => checkIds.has(c.id) && (c.type === "workspace" || c.type === "parser")).map((c) => c.type === "workspace" || c.type === "parser" ? c.path : "");
  const unexpectedPaths = checkIds.has("permitted-workspace-effects") ? record.workspaceDiff.filter((d) => !d.path.startsWith(".harness_backups/")).map((d) => d.path) : [];
  return sha256(JSON.stringify({ version: 2, family: record.scenario.campaignType === "boundary" ? `boundary/${record.scenario.family}` : record.scenario.family, checks: [...checkIds].sort(), paths: [...new Set([...expectedPaths, ...unexpectedPaths])].sort(), target: record.profile.target.registry.map((m) => [m.id, m.model]) })).slice(0, 16);
}
export function appendFindings(root: string, records: ExecutionRecord[]): string[] {
  const representatives = new Map(records.filter((r) => confirmedChecks(r).length).map((r) => [findingFingerprint(r), r]));
  return [...representatives.values()].flatMap((representative) => {
    const fingerprint = appendFinding(root, [representative, ...records.filter((r) => r !== representative)]);
    return fingerprint ? [fingerprint] : [];
  });
}
export function appendFinding(root: string, records: ExecutionRecord[]): string | undefined {
  const first = records.find((r) => confirmedChecks(r).length);
  if (!first) return undefined;
  const file = path.join(root, "tests/BEHAVIORAL_ISSUES.md");
  if (!existsSync(file)) writeFileSync(file, "# Behavioral E2E findings\n\nAppend-only application findings and evidence references.\n");
  const existing = readFileSync(file, "utf8");
  const fingerprint = findingFingerprint(first);
  const occurrence = `<!-- finding-execution:${fingerprint}:${first.executionId} -->\n<!-- execution:${first.executionId} -->`;
  if (existing.includes(`<!-- finding-execution:${fingerprint}:${first.executionId} -->`)) return fingerprint;
  const marker = `<!-- finding:${fingerprint} -->`;
  const failed = records.filter((r) => findingFingerprint(r) === fingerprint && confirmedChecks(r).length).length;
  const replayCommand = `npm run behavioral -- run --target=replay --profile=${path.relative(root, path.join(first.evidenceDir, "profile.json"))} --scenario=${path.relative(root, path.join(first.evidenceDir, "scenario.json"))} --record=${path.relative(root, path.join(first.evidenceDir, "record.json"))}`;
  const relativeEvidence = records.map((r) => `[${r.executionId}](${path.relative(path.dirname(file), path.join(r.evidenceDir, "record.json"))})`).join(", ");
  if (existing.includes(marker)) {
    appendFileSync(file, redact(`\n### Additional occurrence: ${fingerprint}\n\n${occurrence}\nDate: ${first.timestamp}; commit: ${first.commit}; reproduced ${failed}/${records.length}.\n\nEvidence: ${relativeEvidence}\n`));
    return fingerprint;
  }
  const failures = confirmedChecks(first);
  const prompts = first.scenario.actions.filter((a) => a.type === "send");
  const relevantEvents = first.events.filter((e) => ["tool_call", "tool_result", "confirmation_required", "assistant_message", "error", "run_state"].includes(e.event.type));
  appendFileSync(file, redact(`\n## ${fingerprint} — ${first.scenario.description}\n\n${marker}\n${occurrence}\n- Date: ${first.timestamp}\n- Status: open\n- Campaign type: ${first.scenario.campaignType}\n- Category: ${first.scenario.family}\n- Severity score: ${Math.max(...failures.map((r) => r.severity ?? 0))}\n- Commit: ${first.commit}\n- Target mode: ${first.targetMode}\n- Profile: ${first.profile.name} (${first.profileHash})\n- Failure occurrences: ${failed}/${records.length}\n\nExpected: ${first.scenario.objective.intendedOutcome}\n\nObserved: ${failures.map((r) => `${r.id}: ${r.message}`).join("; ")}\n\n### Prompts and interaction sequence\n\n\`\`\`json\n${safeJSON({ prompts, actions: first.scenario.actions, decisions: first.decisions })}\n\`\`\`\n\n### Model configuration and fixture hashes\n\n\`\`\`json\n${safeJSON({ target: first.profile.target, attacker: first.profile.attacker, judge: first.profile.judge, fixtureHashes: first.fixtureHashes })}\n\`\`\`\n\n### Relevant trace\n\n\`\`\`json\n${safeJSON(relevantEvents).slice(0, 16000)}\n\`\`\`\n\nFull local evidence: ${relativeEvidence}\n\nReplay investigation: \`${replayCommand}\`\n\nReal reproduction: rerun the recorded scenario with the same explicit target profile; replay does not establish real-model occurrence rates.\n`));
  return fingerprint;
}
