import { Rng } from "../core/prng.js";
import type { TaskFamily, TaskInstance } from "../core/task-spec.js";
import { wrongTest, nonexistentClause, contradictingData, missingInput, injectedInstruction } from "./adversarial.js";
import { compileErrorRecovery } from "./compile-error-recovery.js";
import { featureHiddenTests } from "./feature-hidden-tests.js";
import { refactorPreserve } from "./refactor-preserve.js";
import { repairL1, repairL1Vague } from "./repair-l1.js";
import { repairMultifile } from "./repair-multifile.js";
import { ledgerVariance, sopCheckNote, specAudit, telemetryAnomaly } from "./work.js";

/** Every registered family. Add new families here. */
export const FAMILIES: TaskFamily[] = [
  repairL1,
  repairL1Vague,
  repairMultifile,
  featureHiddenTests,
  refactorPreserve,
  compileErrorRecovery,
  ledgerVariance,
  telemetryAnomaly,
  sopCheckNote,
  specAudit,
  wrongTest,
  nonexistentClause,
  contradictingData,
  missingInput,
  injectedInstruction,
];

/** Families that can generate arbitrary seeds (everything except the fixed 40-item repair-l1 manifest). */
export const PARAMETRIC_FAMILIES: TaskFamily[] = FAMILIES.filter((f) => f.id !== "repair-l1" && f.id !== "repair-l1-vague");

export function getFamily(id: string): TaskFamily {
  const family = FAMILIES.find((f) => f.id === id);
  if (!family) throw new Error(`Unknown family ${id}`);
  return family;
}

export type SuiteName = "smoke" | "core" | "hard" | "adversarial" | "heldout";

/**
 * Representative seeds for a suite run (kept compact so a full `core` or `hard` run fits in a reasonable budget,
 * while `validate` still checks every `devSeeds` entry).
 */
const SUITE_SEEDS: Record<Exclude<SuiteName, "heldout">, Array<{ family: TaskFamily; seeds: number[] }>> = {
  // 8 tasks: 1 per legacy base repo.
  smoke: [{ family: repairL1, seeds: [1, 6, 11, 16, 21, 26, 31, 36] }],
  core: [
    { family: repairL1Vague, seeds: [1, 11, 21, 31] },
    { family: repairMultifile, seeds: [1, 2, 3, 4] },
    { family: featureHiddenTests, seeds: [1, 2] },
    { family: ledgerVariance, seeds: [1, 2] },
    { family: telemetryAnomaly, seeds: [1, 2] },
    { family: sopCheckNote, seeds: [1, 2] },
    { family: specAudit, seeds: [1, 2] },
  ],
  hard: [
    { family: refactorPreserve, seeds: [1, 2, 3, 4] },
    { family: compileErrorRecovery, seeds: [1, 2, 3, 4] },
  ],
  adversarial: [
    { family: wrongTest, seeds: [1, 2] },
    { family: nonexistentClause, seeds: [1, 2] },
    { family: contradictingData, seeds: [1, 2] },
    { family: missingInput, seeds: [1, 2] },
    { family: injectedInstruction, seeds: [1, 2] },
  ],
};

export async function instancesForSuite(
  suite: SuiteName,
  filter?: { family?: string; task?: string; limit?: number; salt?: number },
): Promise<TaskInstance[]> {
  const out: TaskInstance[] = [];
  if (suite === "heldout") {
    const rng = new Rng((filter?.salt ?? 9001) * 104729 + 17);
    for (const family of PARAMETRIC_FAMILIES) {
      if (filter?.family && family.id !== filter.family) continue;
      for (const s of [rng.int(1000, 9999), rng.int(1000, 9999)]) {
        const instance = await family.generate(s);
        out.push({ ...instance, tier: "heldout" });
      }
    }
    return filter?.limit ? out.slice(0, filter.limit) : out;
  }
  const plan = filter?.task
    ? FAMILIES.map((family) => ({ family, seeds: family.devSeeds }))
    : SUITE_SEEDS[suite];
  const taskFilter = filter?.task ? new Set(filter.task.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
  for (const { family, seeds } of plan) {
    if (filter?.family && family.id !== filter.family) continue;
    for (const seed of seeds) {
      const instance = await family.generate(seed);
      if (taskFilter && !taskFilter.has(instance.id)) continue;
      out.push(instance);
    }
  }
  return filter?.limit ? out.slice(0, filter.limit) : out;
}
