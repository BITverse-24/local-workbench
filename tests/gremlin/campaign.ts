import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadCorpus } from "../scenarios/corpus.js";
import { families } from "../scenarios/schema.js";
import { runScenario, type RunOptions } from "../runner.js";
import { confirmedChecks, appendFinding, findingFingerprint } from "../findings.js";
import { EffortProvider } from "./provider.js";
import { CampaignEffort } from "./effort.js";
import { proposeAttack, proposeFollowup } from "./agent.js";
import { reproduceAndMinimize } from "./reproducer.js";
import { standardEffort } from "../config.js";
import type { ExecutionRecord } from "../recorder.js";
import { safeJSON } from "../helpers/redact.js";

export async function runCampaign(options: RunOptions, limits = standardEffort) {
  const corpus = loadCorpus(options.runtimeRoot);
  const effort = new CampaignEffort(limits);
  const provider = new EffortProvider(options.profile.attacker, options.profile.attackerFallback, limits.attackerCalls, undefined, options.signal);
  const coverage = Object.fromEntries(families.map((family) => [family, 0]));
  const rewards = Object.fromEntries(families.map((family) => [family, 0]));
  const findings: unknown[] = [], errors: string[] = [];
  let previous: ExecutionRecord | undefined;
  let attacks = 0;
  const directory = path.join(options.runtimeRoot, "tests/.runtime/campaigns", options.campaignId); mkdirSync(directory, { recursive: true });
  while (effort.available() && !options.signal?.aborted) {
    const least = [...families].sort((a, b) => coverage[a] < 2 || coverage[b] < 2 ? coverage[a] - coverage[b] : (coverage[a] / (1 + rewards[a])) - (coverage[b] / (1 + rewards[b])))[0];
    const seeds = corpus.scenarios.filter((s) => s.family === least);
    const seed = seeds[coverage[least] % seeds.length];
    let proposed;
    try { proposed = await proposeAttack(provider, seed, previous, effort.started + limits.durationMs); } catch (error) { errors.push(String(error)); break; }
    if (!effort.available() || options.signal?.aborted) break;
    effort.take(); attacks++; coverage[least]++;
    const record = await runScenario({ ...proposed.scenario, deadlineMs: Math.max(1, Math.min(proposed.scenario.deadlineMs, effort.remainingMs())) }, { ...options, followup: (view, deadline) => provider.remainingCalls ? proposeFollowup(provider, seed, view, Math.min(deadline, effort.started + limits.durationMs)) : Promise.resolve(undefined) });
    previous = record;
    if (record.attackerError) errors.push(record.attackerError);
    const failures = confirmedChecks(record);
    const reward = failures.length ? Math.max(...failures.map((r) => r.severity ?? 0)) : 0;
    rewards[least] += reward;
    writeFileSync(path.join(directory, `${record.executionId}.attack.json`), safeJSON({ mutation: proposed.mutation, observedReward: reward, evidence: record.evidenceDir }));
    console.log(JSON.stringify({ attack: attacks, family: least, verdict: record.verdict, reward, effort: effort.executions, evidence: record.evidenceDir }));
    if (failures.length) {
      const reproduction = await reproduceAndMinimize(record, options, effort);
      const candidate = path.join(directory, `${findingFingerprint(record)}.candidate.json`);
      writeFileSync(candidate, safeJSON(reproduction.minimized.scenario));
      if (options.mode === "real") appendFinding(options.runtimeRoot, reproduction.attempts);
      findings.push({ fingerprint: findingFingerprint(record), candidate, completeReproduction: reproduction.complete, occurrences: reproduction.attempts.filter((r) => confirmedChecks(r).length).length, attempts: reproduction.attempts.length });
    }
    if (record.healthError && record.events.length === 0) { errors.push(record.healthError); break; }
  }
  const report = { campaignId: options.campaignId, interrupted: options.signal?.aborted || false, targetMode: options.mode, attacks, executions: effort.executions, discoveryExecutions: effort.discoveryExecutions, triageExecutions: effort.triageExecutions, attackerCalls: provider.calls, coverage, uncoveredFamilies: families.filter((f) => coverage[f] < 2), rewards, findings, errors, providerEvents: provider.events, elapsedMs: Date.now() - effort.started, limits };
  writeFileSync(path.join(directory, "report.json"), safeJSON(report));
  return report;
}
