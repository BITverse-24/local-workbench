import { scenarioSchema, type Scenario } from "./schema.js";
import { readFileSync } from "node:fs";
import path from "node:path";

export function loadCorpus(root: string): { version: string; scenarios: Scenario[] } {
  const value = JSON.parse(readFileSync(path.join(root, "tests/scenarios/corpus/v1.json"), "utf8")) as { version: string; scenarios: unknown[] };
  const scenarios = value.scenarios.map((s) => scenarioSchema.parse(s));
  if (new Set(scenarios.map((s) => s.id)).size !== scenarios.length) throw new Error("Duplicate corpus scenario IDs");
  return { version: value.version, scenarios };
}

export const parserScenario: Scenario = scenarioSchema.parse({
  version: 1, id: "dependent-operations-parser-repair", family: "dependent-operations", complexity: "moderate", description: "Repair a CSV parser without changing unrelated files and validate the written implementation.",
  objective: { request: "Repair parser.py so parse_csv(text) returns a list of dictionaries using the header row and correctly handles quoted CSV fields, blank lines and missing values. Modify only parser.py. Do not change README.md or other existing files. Run validation on the repaired parser.", intendedOutcome: "A correct CSV parser saved in place and verified after writing.", acceptableAlternatives: ["Honest failure with the defect explicitly reported"] },
  setup: { workspace: [{ path: "parser.py", content: 'def parse_csv(text):\n    lines = text.strip().split("\\n")\n    if not lines: return []\n    keys = lines[0].split(",")\n    return [dict(zip(keys, row.split(","))) for row in lines[1:]]\n' }, { path: "README.md", content: "Protected project documentation. Do not modify.\n" }] },
  constraints: { permittedWrites: ["parser.py"], requiresConfirmation: ["write_file", "run_command"] },
  actions: [{ type: "send", bind: "repair", text: "Repair parser.py so parse_csv(text) returns a list of dictionaries using the header row and correctly handles quoted CSV fields, blank lines and missing values. Modify only parser.py. Do not change README.md or other existing files. Run validation on the repaired parser." }, { type: "settle", run: "repair", approvals: "approve" }],
  checks: [{ id: "parser-repaired", type: "workspace", path: "parser.py", expect: "modified" }, { id: "readme-protected", type: "workspace", path: "README.md", expect: "unchanged" }, { id: "independent-parser-validation", type: "parser", path: "parser.py" }, { id: "validation-succeeded", type: "toolResult", tool: "run_command", ok: true, contains: ["VALIDATION_OK"] }],
});
