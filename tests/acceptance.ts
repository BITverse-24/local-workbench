import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runScenario, type RunOptions } from "./runner.js";
import { parserScenario } from "./scenarios/corpus.js";
import { parserMock } from "./harness/mock-model.js";
import { runMetamorphic } from "./metamorphic.js";
import { confirmedChecks } from "./findings.js";

export async function runAcceptance(options: RunOptions) {
  const checks: Array<{ name: string; pass: boolean; evidence: unknown }> = [];
  const positive = await runScenario(parserScenario, { ...options, mode: "mock", mockFactory: () => parserMock() });
  checks.push({ name: "valid repair passes hidden validator and successful application validation", pass: positive.verdict === "pass" && !positive.healthError, evidence: positive.evidenceDir });
  const broken = await runScenario(parserScenario, { ...options, mode: "mock", mockFactory: () => parserMock({ brokenRepair: true }) });
  checks.push({ name: "plausible broken repair fails hidden validator", pass: !broken.healthError && broken.results.some((c) => c.id === "independent-parser-validation" && c.verdict === "fail"), evidence: broken.evidenceDir });
  const replay = await runScenario(parserScenario, { ...options, mode: "replay", replay: positive.traffic });
  checks.push({ name: "exact recorded replay passes", pass: replay.verdict === "pass" && !replay.healthError, evidence: replay.evidenceDir });
  const divergent = structuredClone(parserScenario);
  divergent.actions[0] = { ...divergent.actions[0], ...(divergent.actions[0].type === "send" ? { text: divergent.actions[0].text + " Answer in French." } : {}) };
  const mismatch = await runScenario(divergent, { ...options, mode: "replay", replay: positive.traffic });
  checks.push({ name: "changed request fails closed on replay divergence", pass: !!mismatch.healthError?.includes("replay_divergence"), evidence: mismatch.evidenceDir });
  for (const fault of ["invalid-json", "http-429", "http-500", "empty", "truncated-stream"] as const) {
    const record = await runScenario({ ...parserScenario, deadlineMs: 30000 }, { ...options, mode: "mock", mockFactory: () => parserMock({ fault }) });
    checks.push({ name: `transport fault ${fault} cannot pass`, pass: record.verdict !== "pass", evidence: { directory: record.evidenceDir, verdict: record.verdict, healthError: record.healthError } });
  }
  const relation = await runMetamorphic(parserScenario, { kind: "unrelated-file" }, { ...options, mode: "mock", mockFactory: () => parserMock() });
  checks.push({ name: "unrelated file preserves repair and scope", pass: relation.verdict === "pass", evidence: relation });
  let sawDisplayedReply = false;
  const interactive = await runScenario(parserScenario, { ...options, mode: "mock", mockFactory: () => parserMock(), followup: async (view) => {
    sawDisplayedReply = view.events.some((e) => e.event.type === "assistant_message" && e.event.text.includes("Repaired parser.py"));
    return "Explain which CSV edge cases your validation actually covered; preserve all existing file restrictions.";
  } });
  checks.push({ name: "interactive follow-up sees actual reply and saves the concrete sequence", pass: sawDisplayedReply && interactive.verdict === "pass" && interactive.scenario.actions.some((a) => a.type === "send" && a.bind === "gremlin-interactive"), evidence: interactive.evidenceDir });
  const interruption = new AbortController();
  const interrupted = await runScenario(parserScenario, { ...options, mode: "mock", signal: interruption.signal, mockFactory: () => () => {
    setTimeout(() => interruption.abort(), 50);
    return { delayMs: 30000, body: { choices: [{ message: { content: "Delayed scripted response" } }] } };
  } });
  checks.push({ name: "operator interruption cleans worker and relay, retains inconclusive evidence and files no finding", pass: interrupted.interrupted === true && interrupted.verdict === "inconclusive" && confirmedChecks(interrupted).length === 0 && interrupted.traffic.some((t) => !!t.error), evidence: interrupted.evidenceDir });
  const report = { version: 1, nativeWorker: true, realModels: false, pass: checks.every((c) => c.pass), checks };
  const directory = path.join(options.runtimeRoot, "tests/.runtime"); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "acceptance.json"), JSON.stringify(report, null, 2));
  return report;
}
