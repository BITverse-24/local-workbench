/* Eval CLI entry (bundled by scripts/eval/eval.cjs and run under Electron's Node runtime). */
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { FAMILIES, PARAMETRIC_FAMILIES, getFamily, instancesForSuite, type SuiteName } from "./families/index.js";
import { selfCheck } from "./core/selfcheck.js";
import { compareSuites, type SuiteResultV2 } from "./core/metrics.js";
import { loadRegistry, runSuite } from "./suite.js";

const ROOT = process.cwd();

function args(argv: string[]) {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    const value = next && !next.startsWith("--") ? argv[++i] : "true";
    (out[key] ??= []).push(value);
  }
  return out;
}

function readSalt(explicit?: string): number {
  if (explicit) return Number(explicit);
  if (process.env.EVAL_HELDOUT_SALT) return Number(process.env.EVAL_HELDOUT_SALT);
  const file = process.env.EVAL_HELDOUT_FILE ?? path.join(process.env.HOME ?? "/tmp", ".local-workbench-eval-salt");
  if (existsSync(file)) return Number(readFileSync(file, "utf8").trim()) || 9001;
  return 9001;
}

function resolveModels(wanted: string[] | undefined) {
  const registry = loadRegistry(ROOT);
  const ids = wanted ?? [registry.find((m) => m.enabled)?.id ?? registry[0].id];
  return ids.map((id) => {
    const m = registry.find((r) => r.id === id);
    if (!m) throw new Error(`Model ${id} is not in tests/eval/registry.local.json`);
    return m;
  });
}

function driverBase(keep: boolean) {
  return {
    workerBundle: path.join(ROOT, "tests/.runtime/build/worker.cjs"),
    schemaPath: path.join(ROOT, "backend/src/main/persistence/schema.sql"),
    embedding: { baseUrl: "http://127.0.0.1:1234/v1", model: "text-embedding-nomic-embed-text-v1.5" },
    keepSandbox: keep,
  };
}

function envFeatures(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([k]) => k.startsWith("WORKBENCH_") && process.env[k] !== undefined)
      .map(([k, v]) => [k, String(v)]),
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const a = args(rest);
  const one = (key: string, fallback?: string) => a[key]?.[0] ?? fallback;

  if (command === "validate") {
    let bad = 0;
    for (const family of FAMILIES) {
      if (one("family") && one("family") !== family.id) continue;
      for (const seed of family.devSeeds) {
        const r = await selfCheck(family, seed);
        if (!r.ok) bad++;
        console.log(`${r.ok ? (r.skipped ? "SKIP" : "ok  ") : "FAIL"} ${r.id}${r.skipped ? ` (${r.skipped})` : ""}${r.problems.length ? `\n     ${r.problems.join("\n     ")}` : ""}`);
      }
    }
    console.log(bad ? `\n${bad} invalid task(s)` : "\nAll tasks valid");
    process.exit(bad ? 1 : 0);
  }

  if (command === "list") {
    for (const family of FAMILIES) console.log(`${family.id}\t${family.tier}\t${family.mode}\t${family.devSeeds.length} seeds\t${family.description}`);
    return;
  }

  if (command === "run") {
    const suite = one("suite", "smoke") as SuiteName;
    const k = Number(one("k", suite === "smoke" ? "1" : "3"));
    const models = resolveModels(a.model);
    if (models.length === 1 && suite !== "smoke") {
      console.warn("[eval] Note: running with a single configured model; pass a second --model when comparing across models.");
    }
    const instances = await instancesForSuite(suite, {
      family: one("family"),
      task: one("task"),
      limit: one("limit") ? Number(one("limit")) : undefined,
      salt: readSalt(one("salt")),
    });
    if (!instances.length) throw new Error("No tasks selected");
    const reveal = one("reveal") === "true";
    const quiet = suite === "heldout" && !reveal;
    console.log(`\nEVAL ${suite} — ${instances.length} tasks × k=${k} × ${models.length} model(s)${quiet ? " (aggregate-only; pass --reveal for per-task details)" : ""}\n`);
    const results = await runSuite({
      suite,
      instances,
      k,
      models,
      driver: driverBase(one("keep") === "true"),
      outputDir: path.join(ROOT, "docs/eval/runs"),
      outputFile: one("output"),
      features: envFeatures(),
      quiet,
    });
    if (quiet) {
      for (const r of results) {
        const s = r.stats;
        console.log(`${r.model.id} held-out: pass ${(s.passRate * 100).toFixed(1)}% (95% CI ${(s.ci95[0] * 100).toFixed(0)}–${(s.ci95[1] * 100).toFixed(0)}%), false-completion ${(s.falseCompletionRate * 100).toFixed(1)}% over ${s.runs} runs`);
      }
    }
    process.exit(results.some((r) => r.stats.runs === 0) ? 1 : 0);
  }

  if (command === "variants") {
    const family = getFamily(one("family") ?? PARAMETRIC_FAMILIES[0].id);
    const seeds = (one("seeds") ?? "101,202,303").split(",").map(Number);
    const models = resolveModels(a.model);
    const instances = await Promise.all(seeds.map((s) => family.generate(s)));
    const results = await runSuite({
      suite: `variants-${family.id}`,
      instances,
      k: Number(one("k", "1")),
      models,
      driver: driverBase(false),
      outputDir: path.join(ROOT, "docs/eval/runs"),
      outputFile: one("output"),
      features: envFeatures(),
    });
    for (const r of results) {
      const passed = r.runs.filter((x) => x.pass).length;
      if (passed > 0 && passed < r.runs.length) {
        console.log(`WARNING: ${family.id} passed on ${passed}/${r.runs.length} seed variants — possible seed sensitivity or overfitting.`);
      }
    }
    return;
  }

  if (command === "calibrate") {
    const file = rest[0] ?? one("file");
    if (!file) throw new Error("usage: calibrate <result.json>");
    const res = JSON.parse(readFileSync(path.resolve(ROOT, file), "utf8")) as SuiteResultV2;
    const byTask = new Map<string, { p: number; n: number }>();
    for (const r of res.runs) if (!r.skipped) byTask.set(r.taskId, { p: (byTask.get(r.taskId)?.p ?? 0) + (r.pass ? 1 : 0), n: (byTask.get(r.taskId)?.n ?? 0) + 1 });
    console.log(`Calibration report for ${file} — aggregate pass ${(res.stats.passRate * 100).toFixed(1)}% (target 30–70%)`);
    for (const [id, { p, n }] of byTask) {
      const rate = p / n;
      const flag = n >= 3 && (rate < 0.1 ? "TOO_HARD (<10%)" : rate > 0.9 ? "SATURATED (>90%)" : "in-band");
      console.log(`  ${id}: ${p}/${n} (${(rate * 100).toFixed(0)}%) ${flag}`);
    }
    return;
  }

  if (command === "compare" || command === "gate") {
    const positional = rest.filter((x) => !x.startsWith("--"));
    const [beforePath, afterPath] = [one("baseline") ?? positional[0], one("candidate") ?? positional[1]];
    if (!beforePath || !afterPath) throw new Error(command === "gate" ? "usage: gate [--baseline] <file> [--candidate] <file>" : "usage: compare <before.json> <after.json>");
    const load = (p: string) => JSON.parse(readFileSync(path.resolve(ROOT, p), "utf8")) as SuiteResultV2;
    const before = load(beforePath);
    const after = load(afterPath);
    if (before.schema !== 2 || after.schema !== 2) throw new Error("Both files must be schema 2 results");
    const cmp = compareSuites(before, after);
    console.log(`Baseline ${before.stats.runs} runs → candidate ${after.stats.runs} runs`);
    for (const s of cmp.improvements) console.log(`  + ${s}`);
    for (const s of cmp.notes) console.log(`  = ${s}`);
    for (const s of cmp.regressions) console.log(`  - REGRESSION: ${s}`);
    for (const f of cmp.flips) console.log(`  ~ ${f.taskId}: ${(f.before * 100).toFixed(0)}% → ${(f.after * 100).toFixed(0)}%`);
    process.exit(command === "gate" && cmp.regressions.length ? 1 : 0);
  }

  console.log("usage: eval <run|validate|list|variants|calibrate|compare|gate> [--suite smoke|core|hard|adversarial|heldout] [--k N] [--model id]... [--family id] [--task id] [--limit N] [--output file] [--keep] [--reveal]");
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
