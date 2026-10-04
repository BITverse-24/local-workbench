const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const hook = path.join(root, ".audit/telemetry-hook.cjs");
const script = path.join(root, "scripts/test-flow-b.cjs");
const outRoot = path.join(__dirname, "trials");
const schedule = [
  ["default", 1], ["roomy", 1], ["bounded", 1],
  ["bounded", 2], ["default", 2], ["roomy", 2],
  ["roomy", 3], ["bounded", 3], ["default", 3],
];

function readTelemetry(dir) {
  const file = path.join(dir, "requests.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function runOne(profile, trial) {
  const name = `${profile}-${trial}`;
  const dir = path.join(outRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const outputFile = path.join(dir, "flow-b.log");
  const stream = fs.createWriteStream(outputFile);
  const started = Date.now();
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: {
      ...process.env,
      SW_AGENT_EXPERIMENTAL_BUDGET_PROFILE: profile === "default" ? "default" : profile,
      FLOW_AUDIT_OUTDIR: dir,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${hook}`].filter(Boolean).join(" "),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let outputTail = "";
  for (const source of [child.stdout, child.stderr]) {
    source.on("data", (chunk) => {
      const value = chunk.toString();
      stream.write(value);
      outputTail = (outputTail + value).slice(-16000);
      const lines = value.split(/\r?\n/);
      for (const line of lines) {
        if (/STARTING FLOW B|Run reached terminal state|Flow B Summary|FAIL:/.test(line)) process.stdout.write(`[${name}] ${line.trim()}\n`);
      }
    });
  }
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  stream.end();
  const durationMs = Date.now() - started;
  const records = readTelemetry(dir);
  const usage = (key) => records.reduce((sum, row) => sum + (
    key === "prompt" ? (row.usage?.prompt_tokens ?? 0) :
    key === "completion" ? (row.usage?.completion_tokens ?? 0) :
    (row.usage?.completion_tokens_details?.reasoning_tokens ?? 0)
  ), 0);
  const byPurpose = Object.fromEntries(["classification", "working_turn", "delegated"].map((purpose) => [
    purpose,
    purpose === "working_turn"
      ? records.filter((row) => row.purpose.startsWith("working_")).length
      : records.filter((row) => row.purpose === purpose).length,
  ]));
  const summary = {
    profile, trial, exitCode, accepted: exitCode === 0, wallMs: durationMs,
    flowWallSeconds: Number(outputTail.match(/Run reached terminal state: .*? in ([\d.]+)s/)?.[1] ?? NaN),
    outcome: outputTail.match(/Run reached terminal state: (\w+)/)?.[1] ?? null,
    strictChecksPassed: (outputTail.match(/✅ PASS:/g) ?? []).length,
    strictChecksFailed: (outputTail.match(/❌ FAIL:/g) ?? []).length,
    calls: byPurpose,
    promptTokens: usage("prompt"), completionTokens: usage("completion"), reasoningTokens: usage("reasoning"),
    lengthTerminations: records.filter((row) => row.finishReason === "length").length,
    toolSequence: records.flatMap((row) => row.toolCalls.map((call) => call.name)),
    retries: records.flatMap((row) => row.toolCalls.map((call) => call.name)).reduce((map, tool) => {
      map[tool] = (map[tool] ?? 0) + 1;
      return map;
    }, {}),
    perCall: records.map((row) => ({ purpose: row.purpose, ms: row.durationMs, finishReason: row.finishReason,
      promptTokens: row.usage?.prompt, completionTokens: row.usage?.completion, reasoningTokens: row.usage?.reasoning,
      maxTokens: row.generation?.max_tokens, tools: row.toolCalls.map((call) => call.name) })),
  };
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(`[${name}] DONE ${summary.outcome ?? "no outcome"}; ${summary.flowWallSeconds}s; ${summary.calls.working_turn} working calls; ${summary.completionTokens} output tokens; strict failures=${summary.strictChecksFailed}; exit=${exitCode}\n`);
  return summary;
}

(async () => {
  fs.mkdirSync(outRoot, { recursive: true });
  const results = [];
  for (const [profile, trial] of schedule) {
    process.stdout.write(`\n=== BEGIN ${profile} trial ${trial} ===\n`);
    results.push(await runOne(profile, trial));
  }
  fs.writeFileSync(path.join(__dirname, "benchmark-results.json"), JSON.stringify(results, null, 2));
  process.stdout.write(`\nSaved ${results.length} trial summaries to ${path.join(__dirname, "benchmark-results.json")}\n`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
