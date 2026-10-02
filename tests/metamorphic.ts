import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { scenarioSchema, type Scenario } from "./scenarios/schema.js";
import { runScenario, type RunOptions } from "./runner.js";

export type Transformation = { kind: "paraphrase"; text: string } | { kind: "unrelated-file" } | { kind: "rename-source"; file: string; name: string } | { kind: "change-value"; file: string; from: string; to: string };
export function transformScenario(base: Scenario, transformation: Transformation): Scenario {
  const s = structuredClone(base);
  s.id += `-metamorphic-${transformation.kind}`;
  if (transformation.kind === "paraphrase") {
    const send = s.actions.find((a) => a.type === "send");
    if (!send || send.type !== "send") throw new Error("No request to paraphrase");
    send.text = `${transformation.text}\n\nBinding requirements: ${send.text}`;
  } else if (transformation.kind === "unrelated-file") {
    if (s.setup.workspace.some((f) => f.path === "irrelevant-context.txt")) throw new Error("Distractor filename already exists");
    s.setup.workspace.push({ path: "irrelevant-context.txt", content: "Unrelated shipping timetable. No task instructions.\n", kind: "text" });
    s.checks.push({ id: "metamorphic-distractor-unchanged", type: "workspace", path: "irrelevant-context.txt", expect: "unchanged", flags: "" });
  } else {
    const fixtures = [...s.setup.workspace, ...s.setup.attachments, ...s.setup.knowledgeBase];
    const file = fixtures.find((f) => f.path === transformation.file);
    if (!file) throw new Error("Metamorphic source fixture missing");
    if (transformation.kind === "rename-source") {
      if (fixtures.some((f) => f.path === transformation.name)) throw new Error("Rename collides with existing fixture");
      const old = file.path; file.path = transformation.name;
      for (const action of s.actions) if (action.type === "send") { action.attachments = action.attachments.map((p) => p === old ? file.path : p); action.text = action.text.split(old).join(file.path); }
      for (const check of s.checks) {
        if (check.type === "semantic") check.sourceFiles = check.sourceFiles.map((p) => p === old ? file.path : p);
        if (check.type === "output") check.contains = check.contains.map((v) => v.split(old).join(file.path));
        if ((check.type === "workspace" || check.type === "parser") && check.path === old) check.path = file.path;
      }
      s.constraints.permittedWrites = s.constraints.permittedWrites.map((p) => p === old ? file.path : p);
      s.objective.request = s.objective.request.split(old).join(file.path);
      s.objective.intendedOutcome = s.objective.intendedOutcome.split(old).join(file.path);
    } else {
      if (!transformation.from || transformation.from === transformation.to || !file.content.includes(transformation.from)) throw new Error("Source value transformation has no effect");
      const checks = s.checks.filter((c) => c.type === "output" && c.contains.includes(transformation.from));
      if (!checks.length) throw new Error("Value change requires an independently defined exact-value output check");
      file.content = file.content.split(transformation.from).join(transformation.to);
      for (const check of checks) if (check.type === "output") { check.contains = check.contains.map((v) => v === transformation.from ? transformation.to : v); check.excludes = [...check.excludes, transformation.from]; }
      // Unit/citation checks may express the same independently expected value
      // as a literal regex. Update those literals too, without changing the
      // surrounding unit or relation asserted by the evaluator.
      const regexLiteral = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const oldLiterals = [regexLiteral(transformation.from), transformation.from.replace(/\./g, "[.]")].sort((a, b) => b.length - a.length);
      for (const check of s.checks) if (check.type === "output" && check.pattern) for (const literal of oldLiterals) {
        if (check.pattern.includes(literal)) { check.pattern = check.pattern.split(literal).join(regexLiteral(transformation.to)); break; }
      }
    }
  }
  return scenarioSchema.parse(s);
}
export async function runMetamorphic(base: Scenario, transformation: Transformation, options: RunOptions) {
  const changed = transformScenario(base, transformation);
  const before = await runScenario(base, options);
  const after = await runScenario(changed, options);
  const report = { version: 1, transformation, targetMode: options.mode, verdict: before.healthError || after.healthError || before.verdict === "inconclusive" || after.verdict === "inconclusive" ? "inconclusive" : before.verdict === "pass" && after.verdict === "pass" ? "pass" : "fail", property: "Both variants satisfy their independent constraints and expected source facts", baseline: before.evidenceDir, variant: after.evidenceDir };
  const directory = path.join(options.runtimeRoot, "tests/.runtime/metamorphic"); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${options.campaignId}.json`), JSON.stringify(report, null, 2));
  return report;
}
