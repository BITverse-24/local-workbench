import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FileMap, TaskFamily, TaskInstance } from "../core/task-spec.js";

interface MutationItem {
  id: string;
  base: string;
  file: string;
  mutation: string;
  prompt: string;
  original: string;
  mutated: string;
  expectChangedFiles: string[];
  oracle: string;
}

const root = () => process.cwd();

export function readBase(base: string): FileMap {
  const dir = path.join(root(), "tests/eval/bases", base);
  const out: FileMap = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "__pycache__" || entry.endsWith(".pyc")) continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full).replace(/\\/g, "/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

export function loadMutations(): MutationItem[] {
  return JSON.parse(readFileSync(path.join(root(), "tests/eval/tasks/manifest.json"), "utf8")) as MutationItem[];
}

const isTestPath = (file: string) => /(^|\/)(test|tests)\//.test(file) || /(^|\/)test_[^/]+\.py$/.test(file) || /\.test\.[cm]?[jt]s$/.test(file);

function build(item: MutationItem, seed: number, family: string, tier: TaskInstance["tier"], prompt: string): TaskInstance {
  const base = readBase(item.base);
  const clean = String(base[item.file]);
  if (!clean.includes(item.original)) throw new Error(`mutation ${item.id}: original snippet not found`);
  const workspace: FileMap = { ...base, [item.file]: clean.replace(item.original, item.mutated) };
  return {
    id: `${family}/${item.id}`,
    family,
    seed,
    tier,
    mode: "agent",
    prompt,
    workspace,
    reference: { files: { [item.file]: clean } },
    oracles: [
      { type: "command", command: item.oracle },
      { type: "scope", allow: item.expectChangedFiles, protect: Object.keys(base).filter(isTestPath), requireChange: true },
    ],
    expectation: "complete",
    limits: { timeoutMs: 450000 },
  };
}

const items = () => loadMutations();
const seeds = () => items().map((_, i) => i + 1);

export const repairL1: TaskFamily = {
  id: "repair-l1",
  tier: "smoke",
  mode: "agent",
  description: "Single-line mutation in a one-file repo; the prompt names the file and function (legacy suite).",
  devSeeds: Array.from({ length: 40 }, (_, i) => i + 1),
  generate(seed) {
    const item = items()[seed - 1];
    if (!item) throw new Error(`repair-l1 has no seed ${seed}`);
    return build(item, seed, "repair-l1", "smoke", item.prompt);
  },
};

export const repairL1Vague: TaskFamily = {
  id: "repair-l1-vague",
  tier: "core",
  mode: "agent",
  description: "Same mutations as repair-l1 but the prompt names neither the file nor the function.",
  // One vague task per base repo so the tier stays affordable.
  devSeeds: Array.from({ length: 8 }, (_, i) => i * 5 + 1),
  generate(seed) {
    const item = items()[seed - 1];
    if (!item) throw new Error(`repair-l1-vague has no seed ${seed}`);
    const kind = item.base.startsWith("py-") ? "Python module" : "JavaScript module";
    return build(item, seed, "repair-l1-vague", "core", `The tests in this project are failing. Find the cause in the ${kind} and fix it so all tests pass. Do not change the tests.`);
  },
};

export { seeds as repairL1Seeds };
