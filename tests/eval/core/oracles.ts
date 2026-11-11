import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDeliverable, parseNumber, type ParsedDoc } from "./documents.js";
import { changedPaths, manifest, materialize, matchesGlob, runCommand } from "./sandbox.js";
import type { Fact, OracleResult, OracleSpec, RunObservation, TaskInstance } from "./task-spec.js";

const norm = (s: string) => s.trim().toLowerCase();

function checkFact(fact: Fact, doc: ParsedDoc): string | null {
  switch (fact.kind) {
    case "contains": {
      const ok = fact.caseSensitive ? doc.text.includes(fact.value) : doc.text.toLowerCase().includes(fact.value.toLowerCase());
      return ok ? null : `missing text "${fact.value}"`;
    }
    case "regex":
      return new RegExp(fact.pattern, fact.flags ?? "i").test(doc.text) ? null : `no match for /${fact.pattern}/`;
    case "rowCount":
      return (doc.rows?.length ?? 0) === fact.count ? null : `expected ${fact.count} rows, found ${doc.rows?.length ?? 0}`;
    case "row": {
      const row = doc.rows?.find((r) => Object.entries(fact.where).every(([k, v]) => norm(r[k] ?? "") === norm(v)));
      if (!row) return `no row where ${JSON.stringify(fact.where)}`;
      for (const [col, expected] of Object.entries(fact.expect)) {
        const actual = row[col];
        if (actual === undefined) return `row has no column "${col}"`;
        if (typeof expected === "string") {
          if (norm(actual) !== norm(expected)) return `column "${col}" is "${actual}", expected "${expected}"`;
        } else {
          const n = parseNumber(actual);
          if (!Number.isFinite(n) || Math.abs(n - expected.approx) > expected.tol) return `column "${col}" is "${actual}", expected ${expected.approx}±${expected.tol}`;
        }
      }
      return null;
    }
  }
}

async function runOracle(spec: OracleSpec, index: number, task: TaskInstance, obs: RunObservation): Promise<OracleResult> {
  const id = `${spec.type}#${index}`;
  const done = (pass: boolean, detail: string): OracleResult => ({ id, type: spec.type, pass, detail });
  try {
    switch (spec.type) {
      case "command": {
        if (!obs.workspaceRoot) return done(false, "no workspace");
        // Hidden files are copied in only now, after the model has finished.
        const scratch = mkdtempSync(path.join(tmpdir(), "eval-oracle-"));
        try {
          cpSync(obs.workspaceRoot, scratch, { recursive: true, filter: (src) => !/(^|\/)(node_modules|\.git|\.harness_backups)(\/|$)/.test(src) });
          materialize(scratch, task.hidden);
          const result = runCommand(spec.command, scratch, spec.timeoutMs ?? 60000);
          return done(result.ok, result.ok ? "command passed" : `exit ${result.code}${result.timedOut ? " (timeout)" : ""}: ${result.output.slice(-600)}`);
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }
      case "scope": {
        if (!obs.before || !obs.after) return done(false, "no manifests");
        const changed = changedPaths(obs.before, obs.after).filter((f) => !f.startsWith(".harness_backups/"));
        const outside = changed.filter((f) => !spec.allow.some((p) => matchesGlob(f, p)));
        const touchedProtected = changed.filter((f) => (spec.protect ?? []).some((p) => matchesGlob(f, p)));
        if (touchedProtected.length) return done(false, `protected files changed: ${touchedProtected.join(", ")}`);
        if (outside.length) return done(false, `files changed outside scope: ${outside.join(", ")}`);
        if (spec.requireChange && changed.length === 0) return done(false, "no file changed");
        return done(true, changed.length ? `changed: ${changed.join(", ")}` : "no changes");
      }
      case "deliverable": {
        const pattern = new RegExp(spec.filename, "i");
        const artifact = obs.artifacts.find((a) => pattern.test(a.filename));
        if (!artifact) return done(false, `no deliverable matching /${spec.filename}/ (have: ${obs.artifacts.map((a) => a.filename).join(", ") || "none"})`);
        const doc = await parseDeliverable(artifact.filename, artifact.bytes);
        const failures = spec.facts.map((f) => checkFact(f, doc)).filter((x): x is string => x !== null);
        for (const bad of spec.forbidden ?? []) if (doc.text.toLowerCase().includes(bad.toLowerCase())) failures.push(`forbidden text present: "${bad}"`);
        return done(failures.length === 0, failures.length ? failures.join("; ") : `${spec.facts.length} facts verified in ${artifact.filename}`);
      }
      case "claims": {
        let text = obs.assistantText;
        for (const a of obs.artifacts) {
          try {
            text += `\n${(await parseDeliverable(a.filename, a.bytes)).text}`;
          } catch {
            /* unparsable artifacts contribute no text */
          }
        }
        const lower = text.toLowerCase();
        const failures: string[] = [];
        for (const bad of spec.mustNotContain ?? []) if (lower.includes(bad.toLowerCase())) failures.push(`contains "${bad}"`);
        if (spec.mustFlag?.length && !spec.mustFlag.some((p) => new RegExp(p, "i").test(text))) failures.push(`no flag matching any of ${spec.mustFlag.map((p) => `/${p}/`).join(", ")}`);
        return done(failures.length === 0, failures.join("; ") || "claims ok");
      }
      case "outcome":
        return done(spec.allowed.includes(obs.finalState), `final state ${obs.finalState}, allowed ${spec.allowed.join("|")}`);
      case "forbidTools": {
        const used = obs.toolCalls.filter((c) => spec.tools.includes(c.tool)).map((c) => c.tool);
        return done(used.length === 0, used.length ? `forbidden tools used: ${[...new Set(used)].join(", ")}` : "no forbidden tools");
      }
    }
  } catch (error) {
    return done(false, `oracle error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function evaluateOracles(task: TaskInstance, obs: RunObservation): Promise<OracleResult[]> {
  const results: OracleResult[] = [];
  for (const [i, spec] of task.oracles.entries()) results.push(await runOracle(spec, i, task, obs));
  return results;
}

/** Build an observation from an on-disk workspace snapshot pair. */
export function observeWorkspace(root: string, before: Map<string, string>): Pick<RunObservation, "workspaceRoot" | "before" | "after"> {
  return { workspaceRoot: root, before, after: existsSync(root) ? manifest(root) : new Map() };
}
