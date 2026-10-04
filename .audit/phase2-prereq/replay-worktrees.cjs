const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const auditRoot = __dirname;
const schedule = [
  ["phase16-runtime", 1], ["current-head", 1],
  ["phase16-runtime", 2], ["current-head", 2],
  ["phase16-runtime", 3], ["current-head", 3],
];

function records(dir) {
  const file = path.join(dir, "requests.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)) : [];
}

async function run(profile, trial) {
  const checkout = path.join(auditRoot, "worktrees", profile);
  const outDir = path.join(auditRoot, "worktree-replay", profile, "trial-" + trial);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const log = fs.createWriteStream(path.join(outDir, "flow-b.log"));
  const env = { ...process.env, FLOW_AUDIT_OUTDIR: outDir };
  delete env.SW_AGENT_EXPERIMENTAL_BUDGET_PROFILE;
  delete env.FLOW_GENERATION_BUDGET_PROFILE;
  if (profile === "phase16-runtime") env.SW_AGENT_EXPERIMENTAL_BUDGET_PROFILE = "bounded";
  else env.SW_AGENT_GENERATION_PROFILE = "demo_fast";
  env.NODE_OPTIONS = [env.NODE_OPTIONS, "--require=" + path.join(checkout, ".audit/telemetry-hook.cjs")].filter(Boolean).join(" ");

  const child = spawn(process.execPath, ["scripts/test-flow-b.cjs"], { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { const text = chunk.toString(); output += text; log.write(text); });
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  log.end();
  const xs = records(outDir);
  const working = xs.filter((x) => x.purpose.startsWith("working_"));
  const sum = (f) => working.reduce((n, x) => n + (f(x) || 0), 0);
  const row = {
    profile, trial, exitCode, passed: exitCode === 0,
    wallSeconds: Number(output.match(/Run reached terminal state: .*? in ([\d.]+)s/)?.[1] ?? NaN),
    terminalState: output.match(/Run reached terminal state: (\w+)/)?.[1] ?? null,
    strictPasses: (output.match(/✅ PASS:/g) || []).length,
    strictFailures: (output.match(/❌ FAIL:/g) || []).length,
    workingCalls: working.length,
    completionTokens: sum((x) => x.usage?.completion_tokens),
    reasoningTokens: sum((x) => x.usage?.completion_tokens_details?.reasoning_tokens),
    promptTokens: sum((x) => x.usage?.prompt_tokens),
    lengthStops: working.filter((x) => x.finishReason === "length").length,
    toolSequence: working.flatMap((x) => x.toolCalls.map((t) => t.name)),
    capabilityDiscoveryCalls: working.flatMap((x) => x.toolCalls).filter((t) => t.name === "request_capability").length,
    perCall: working.map((x) => ({ purpose: x.purpose, latencyMs: x.durationMs, finishReason: x.finishReason,
      promptTokens: x.usage?.prompt_tokens, completionTokens: x.usage?.completion_tokens,
      reasoningTokens: x.usage?.completion_tokens_details?.reasoning_tokens, maxTokens: x.generation?.max_tokens,
      tools: x.toolCalls.map((t) => t.name) })),
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(row, null, 2));
  console.log(JSON.stringify(row));
  return row;
}

(async () => {
  const results = [];
  for (const [profile, trial] of schedule) results.push(await run(profile, trial));
  fs.writeFileSync(path.join(auditRoot, "worktree-replay-results.json"), JSON.stringify(results, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
