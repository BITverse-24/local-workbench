import path from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadProfile } from "./config.js";
import { verifyIsolation } from "./harness/isolation-probes.js";
import { runScenario } from "./runner.js";
import { parserScenario } from "./scenarios/corpus.js";
import { parserMock } from "./harness/mock-model.js";
import { scenarioSchema } from "./scenarios/schema.js";
import { redact } from "./helpers/redact.js";
import { EffortProvider } from "./gremlin/provider.js";
import { readHidden } from "./helpers/hidden-input.js";
import { runBenchmark, compareBenchmarks, type BenchmarkReport } from "./benchmark/benchmark.js";
import { runCampaign } from "./gremlin/campaign.js";
import { standardEffort } from "./config.js";
import { appendFinding, appendFindings } from "./findings.js";
import type { ExecutionRecord } from "./recorder.js";
import { runAcceptance } from "./acceptance.js";
import { runMetamorphic, type Transformation } from "./metamorphic.js";
import { preflightTarget } from "./harness/preflight.js";

const cancellation = new AbortController();
const interrupt = () => cancellation.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

async function main(): Promise<void> {
  const root = process.cwd();
  const [command, ...args] = process.argv.slice(2);
  const flags = new Map(args.filter((s) => s.startsWith("--")).map((s) => { const [key, ...value] = s.slice(2).split("="); return [key, value.join("=") || "true"]; }));
  if (!command || command === "help") { console.log("Behavioral E2E: doctor | acceptance | bridge-smoke | run | benchmark | campaign | metamorphic | compare | provider-probe | report\n--profile=FILE --target=real|mock|replay --scenario=FILE --record=FILE\n--attacker=openrouter|local|none --judge=none|openrouter|local --key-stdin\nbenchmark: --repeat=3 --ids=id1,id2; compare: --before=FILE --after=FILE\nreport: --records=record1.json,record2.json\nModels and credentials are explicit; mock runs never substitute for real-model acceptance."); return; }
  if (command === "compare") {
    const before = JSON.parse(readFileSync(flags.get("before") ?? "", "utf8")) as BenchmarkReport;
    const after = JSON.parse(readFileSync(flags.get("after") ?? "", "utf8")) as BenchmarkReport;
    const comparison = compareBenchmarks(before, after); console.log(JSON.stringify(comparison, null, 2)); process.exitCode = comparison.compatible ? 0 : 2; return;
  }
  if (command === "report") {
    const records = (flags.get("records") ?? "").split(",").filter(Boolean).map((file) => JSON.parse(readFileSync(file, "utf8")) as ExecutionRecord);
    if (!records.length || records.some((r) => r.version !== 1 || r.targetMode !== "real" || !Array.isArray(r.results))) throw new Error("Reporting requires real execution records");
    console.log(JSON.stringify({ findings: appendFindings(root, records) })); return;
  }
  if (command === "provider-probe") {
    const profile = loadProfile(flags.get("profile") ?? "tests/profiles/local.example.json");
    const keyEnv = profile.attacker?.apiKeyEnv;
    if (flags.has("key-stdin") && keyEnv) process.env[keyEnv] = await readHidden("Development attacker key (hidden): ");
    try {
      const provider = new EffortProvider(profile.attacker, profile.attackerFallback, 4, undefined, cancellation.signal);
      const output = await provider.complete([{ role: "system", content: "Follow the user's instruction. Return only valid JSON." }, { role: "user", content: 'Return exactly {"framework_provider_probe":"ok"}.' }]);
      const parsed = JSON.parse(output.replace(/^```(?:json)?\s*|\s*```$/g, ""));
      if (parsed.framework_provider_probe !== "ok") throw new Error("Provider probe returned an unexpected result");
      console.log(JSON.stringify({ providerProbe: "pass", provider: provider.active?.name, model: provider.active?.model, calls: provider.calls, events: provider.events }));
    } finally { if (flags.has("key-stdin") && keyEnv) delete process.env[keyEnv]; }
    return;
  }
  const isolation = await verifyIsolation(root);
  console.log(JSON.stringify({ isolation }));
  if (!isolation.pass) throw new Error("Native isolation gate failed; execution stopped");
  if (command === "doctor") return;
  let profile = loadProfile(flags.get("profile") ?? "tests/profiles/local.example.json");
  if (flags.has("attacker") && !["openrouter", "local", "none"].includes(flags.get("attacker")!)) throw new Error("Invalid attacker mode");
  if (flags.get("attacker") === "local") profile = { ...profile, attacker: undefined };
  if (flags.has("key-stdin") && profile.attacker?.apiKeyEnv) process.env[profile.attacker.apiKeyEnv] = await readHidden("Development attacker key (hidden): ");
  const judgeMode = flags.get("judge") ?? "none";
  if (!["none", "openrouter", "local"].includes(judgeMode)) throw new Error("Invalid judge mode");
  const judge = judgeMode === "none" ? undefined : new EffortProvider(judgeMode === "local" ? profile.judgeFallback : profile.judge, judgeMode === "local" ? undefined : profile.judgeFallback, standardEffort.judgeCalls, undefined, cancellation.signal);
  const scenario = flags.get("scenario") ? scenarioSchema.parse(JSON.parse(readFileSync(flags.get("scenario")!, "utf8"))) : parserScenario;
  const mode = flags.get("target") ?? "real";
  if (!["real", "mock", "replay"].includes(mode)) throw new Error("Invalid target mode");
  const replay = mode === "replay" ? JSON.parse(readFileSync(flags.get("record") ?? "", "utf8")).traffic : undefined;
  const options = { runtimeRoot: root, profile, campaignId: randomUUID(), signal: cancellation.signal, mode: mode as "real" | "mock" | "replay", mockFactory: mode === "mock" ? () => parserMock({ brokenRepair: flags.get("broken") === "true" }) : undefined, replay, judge };
  if (mode === "real" && command !== "acceptance") Object.assign(options, { modelMetadata: await preflightTarget(profile) });
  if (command === "acceptance") { const report = await runAcceptance(options); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.pass ? 0 : 2; return; }
  if (command === "metamorphic") {
    let transformation: Transformation;
    const kind = flags.get("transform") ?? "unrelated-file";
    if (kind === "unrelated-file") transformation = { kind };
    else if (kind === "paraphrase") transformation = { kind, text: flags.get("text") ?? "Please perform this task while preserving every stated constraint." };
    else if (kind === "rename-source") transformation = { kind, file: flags.get("file") ?? "", name: flags.get("name") ?? "" };
    else if (kind === "change-value") transformation = { kind, file: flags.get("file") ?? "", from: flags.get("from") ?? "", to: flags.get("to") ?? "" };
    else throw new Error("Invalid metamorphic transformation");
    const report = await runMetamorphic(scenario, transformation, options); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.verdict === "pass" ? 0 : report.verdict === "fail" ? 1 : 2; return;
  }
  if (command === "benchmark" || (command === "campaign" && flags.get("attacker") === "none")) {
    const report = await runBenchmark(options, Number(flags.get("repeat") ?? 3), flags.get("ids")?.split(",")); console.log(JSON.stringify(report, null, 2));
    process.exitCode = Object.values(report.strata).some((s) => s.inconclusive) ? 2 : Object.values(report.strata).some((s) => s.fail) ? 1 : 0; return;
  }
  if (command === "campaign") {
    const limits = { ...standardEffort, executions: Number(flags.get("executions") ?? standardEffort.executions), attackerCalls: Number(flags.get("attacker-calls") ?? standardEffort.attackerCalls), durationMs: Number(flags.get("duration-ms") ?? standardEffort.durationMs), reservedExecutions: Number(flags.get("reserve") ?? standardEffort.reservedExecutions) };
    if (Object.values(limits).some((n) => !Number.isInteger(n) || n < 0) || limits.executions <= limits.reservedExecutions || !limits.attackerCalls || !limits.durationMs) throw new Error("Invalid campaign effort limits");
    const report = await runCampaign(options, limits, flags.get("ids")?.split(",")); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.errors.length ? 2 : report.findings.length ? 1 : 0; return;
  }
  if (command !== "run") throw new Error("Unknown command");
  const record = await runScenario(scenario, options);
  if (mode === "real") appendFinding(root, [record]);
  console.log(JSON.stringify({ scenario: record.scenario.id, verdict: record.verdict, results: record.results.map(({ id, verdict, message }) => ({ id, verdict, message })), evidence: path.relative(root, record.evidenceDir) }, null, 2));
  process.exitCode = record.healthError || record.verdict === "inconclusive" ? 2 : record.verdict === "fail" ? 1 : 0;
}
main().catch((error) => { console.error(redact(String(error))); process.exitCode = 2; }).finally(() => {
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  if (cancellation.signal.aborted) process.exitCode = 130;
});
