import { writeFileSync, mkdirSync, copyFileSync, realpathSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ModelRelay, type MockHandler } from "./harness/model-relay.js";
import { createSandbox, stageScenario, macProfile, spawnContained, destroySandbox, runtimeReadPaths } from "./harness/sandbox.js";
import { watchWorker, terminateTree } from "./harness/watchdog.js";
import { WorkerClient } from "./harness/client.js";
import { terminalStates, type WorkerBootConfig } from "./harness/protocol.js";
import { snapshot, diff, containedFile } from "./helpers/files.js";
import { pause, throwIfInterrupted } from "./helpers/cancellation.js";
import { registryForRelay, profileHash, type Profile } from "./config.js";
import { scenarioSchema, type Scenario } from "./scenarios/schema.js";
import { Recorder, type ExecutionRecord, type TrafficRecord } from "./recorder.js";
import { evaluate, verdict } from "./evaluator/evaluator.js";
import { parseArtifact } from "./evaluator/checks/artifact-parser.js";
import type { EffortProvider } from "./gremlin/provider.js";

export interface RunOptions { runtimeRoot: string; profile: Profile; mode: "real" | "replay" | "mock"; campaignId: string; signal?: AbortSignal; mock?: MockHandler; mockFactory?: () => MockHandler; replay?: TrafficRecord[]; judge?: EffortProvider; modelMetadata?: Record<string, unknown>; followup?: (view: { events: ExecutionRecord["events"]; artifactContents: Record<string, string> }, deadline: number) => Promise<string | undefined>; }
export async function runScenario(input: Scenario, options: RunOptions): Promise<ExecutionRecord> {
  throwIfInterrupted(options.signal);
  const scenario = scenarioSchema.parse(input);
  const started = Date.now();
  const executionId = randomUUID();
  const box = createSandbox(path.join(options.runtimeRoot, "tests/.runtime/sandboxes"));
  const evidenceDir = path.join(options.runtimeRoot, "tests/.runtime/evidence", options.campaignId, executionId);
  const recorder = new Recorder(evidenceDir);
  stageScenario(box, scenario);
  writeFileSync(path.join(evidenceDir, "scenario.json"), JSON.stringify(scenario, null, 2));
  writeFileSync(path.join(evidenceDir, "profile.json"), JSON.stringify(options.profile, null, 2));
  for (const area of ["workspace", "attachments", "kb"]) {
    const source = path.join(box.root, area);
    for (const [relative, item] of Object.entries(snapshot(source))) if (item.kind === "file") {
      const saved = path.join(evidenceDir, "fixtures", area, relative);
      mkdirSync(path.dirname(saved), { recursive: true }); copyFileSync(path.join(source, relative), saved);
    }
  }
  const before = snapshot(box.workspace);
  const fixtureHashes = snapshot(box.root);
  const canaryBefore = snapshot(box.canary);
  let client: WorkerClient | undefined;
  const relay = new ModelRelay(options.profile, options.mode, (r) => recorder.append("model-traffic", r), options.mockFactory?.() ?? options.mock, options.replay, () => {
    const identities: Record<string, string> = { [box.root]: "<scenario-root>" };
    const runs = [...new Set((client?.events ?? []).map((e) => e.event.runId))];
    for (const [index, run] of runs.entries()) identities[run] = `<run:${index}>`;
    const backups = new Set<string>();
    for (const entry of client?.events ?? []) if (entry.event.type === "tool_result" && (entry.event.tool as string) === "write_file" && entry.event.ok) {
      try {
        const value = JSON.parse(entry.event.output ?? "{}");
        if (typeof value.backupPath === "string" && value.backupPath.startsWith(".harness_backups/")) backups.add(value.backupPath.split("/").slice(0, 2).join("/"));
      } catch { /* non-JSON tool output is preserved exactly */ }
    }
    for (const [index, backup] of [...backups].entries()) identities[backup] = `<backup:${index}>`;
    return identities;
  }, () => {
    const telemetry: Record<string, string> = {};
    for (const entry of client?.events ?? []) if (entry.event.type === "tool_result" && (entry.event.tool as string) === "run_command" && entry.event.output) {
      try {
        const result = JSON.parse(entry.event.output);
        if (typeof result.durationMs === "number" && typeof result.exitCode === "number" && typeof result.stdout === "string" && typeof result.stderr === "string") telemetry[entry.event.output] = JSON.stringify({ ...result, durationMs: "<observed-command-duration>" });
      } catch { /* Preserve output without an observed runtime telemetry field */ }
    }
    return telemetry;
  });
  let stopWatch: (() => void) | undefined;
  let record: ExecutionRecord;
  let healthError: string | undefined;
  let attackerError: string | undefined;
  const bindings = new Map<string, string>();
  let persistence: unknown;
  let commit = "unavailable";
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: options.runtimeRoot, encoding: "utf8" }).trim(); } catch {}
  const origin = await relay.start();
  const registry = registryForRelay(options.profile, origin);
  const schemaPath = path.join(box.root, "config", "schema.sql");
  copyFileSync(path.join(options.runtimeRoot, "backend/src/main/persistence/schema.sql"), schemaPath);
  const config: WorkerBootConfig = { root: box.root, setup: scenario.setup, campaignType: scenario.campaignType, registry, embedding: { ...options.profile.target.embedding, baseUrl: `${origin}/embedding/v1` }, schemaPath };
  const configPath = path.join(box.root, "config", "boot.json");
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(path.join(box.root, "config", "models.json"), JSON.stringify({ models: registry }));
  const interrupt = () => {
    client?.fail(new Error("Execution interrupted by operator"));
    if (client) terminateTree(client.child);
  };
  options.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    throwIfInterrupted(options.signal);
    const electron = realpathSync(path.join(options.runtimeRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"));
    const bundle = realpathSync(path.join(options.runtimeRoot, "tests/.runtime/build/worker.cjs"));
    const reads = [path.join(options.runtimeRoot, "node_modules"), bundle, ...runtimeReadPaths()];
    if (options.profile.sharedGPU) recorder.append("environment", { sharedGPU: true });
    const profile = macProfile(box, reads, Number(new URL(origin).port));
    const child = spawnContained(box, profile, electron, [bundle, configPath]);
    client = new WorkerClient(child, (kind, data) => recorder.append(kind, data), () => snapshot(box.workspace));
    stopWatch = watchWorker(child, box, scenario.deadlineMs, (reason) => client!.fail(new Error(reason)));
    await client.ready(Math.min(60000, scenario.deadlineMs));
    let followedUp = false;
    for (let actionIndex = 0; actionIndex < scenario.actions.length; actionIndex++) {
      const action = scenario.actions[actionIndex];
      throwIfInterrupted(options.signal);
      const remaining = scenario.deadlineMs - (Date.now() - started);
      if (remaining <= 0) throw new Error("Scenario effort deadline exceeded");
      const runId = "run" in action ? bindings.get(action.run) : undefined;
      if ("run" in action && !runId) throw new Error("Run binding unavailable");
      if (action.type === "send") {
        for (const decision of client.changes) if (decision.workspaceBefore && !decision.workspaceAfter) { decision.workspaceAfter = snapshot(box.workspace); decision.endSequence = client.events.length; }
        const result = await client.call<{ runId: string }>("send", { mode: action.mode, chat: action.chat, text: action.text, files: action.attachments, temperature: action.temperature, groundingEnabled: action.groundingEnabled, preferredRoute: action.preferredRoute }, remaining);
        bindings.set(action.bind, result.runId);
      } else if (action.type === "settle") await client.settle(runId!, action.approvals, remaining);
      else if (action.type === "wait") await client.call("wait", { runId, type: action.event, state: action.state, timeoutMs: Math.min(action.timeoutMs, remaining) }, Math.min(action.timeoutMs, remaining) + 1000);
      else if (action.type === "pause") await pause(Math.min(action.durationMs, remaining), options.signal);
      else if (action.type === "inspect") await client.call("inspect");
      else if (action.type === "cancel") {
        client.decide(runId!, "cancel");
        await client.call("invoke", { channel: "workbench:cancelRun", input: { runId } });
      } else if (action.type === "confirm") {
        const confirmation = [...client.events].reverse().find((e) => e.event.runId === runId && e.event.type === "confirmation_required");
        if (!confirmation || confirmation.event.type !== "confirmation_required") throw new Error("No bound confirmation available");
        client.decide(runId!, action.approved ? "approve" : "reject", confirmation.event.action.actionId);
        void client.call("invoke", { channel: "workbench:confirmAction", input: { runId, actionId: confirmation.event.action.actionId, approved: action.approved } }, remaining).catch((error) => client!.fail(error));
      } else {
        let rejected = false;
        try { await client.call("invoke", { channel: action.channel, input: action.args }, remaining); } catch (error) { if (!action.expectError) throw error; rejected = true; }
        if (action.expectError && !rejected) client.behavioralFailures.push({ id: `boundary-rejection-${actionIndex}`, message: "Invalid boundary operation was accepted instead of rejected", evidence: { channel: action.channel, args: action.args } });
      }
      if (actionIndex === scenario.actions.length - 1 && options.followup && !followedUp) {
        followedUp = true;
        const visibleArtifacts: Record<string, string> = {};
        for (const e of client.events) if (e.event.type === "artifact_ready") {
          const a = e.event.artifact;
          try { visibleArtifacts[`${a.runId}/${a.filename}`] = await parseArtifact(a.relativePath.startsWith("runs/") ? box.data : box.workspace, a.relativePath); } catch { /* A user cannot read a malformed artifact. */ }
        }
        let text: string | undefined;
        try { text = await options.followup({ events: client.events, artifactContents: visibleArtifacts }, started + scenario.deadlineMs); }
        catch (error) { attackerError = String(error); recorder.append("gremlin-error", attackerError); }
        if (text) {
          if (text.length > 2000) throw new Error("Interactive follow-up exceeds action limit");
          const lastSend = scenario.actions.filter((a) => a.type === "send").at(-1);
          const lastSettle = scenario.actions.filter((a) => a.type === "settle").at(-1);
          const bind = "gremlin-interactive";
          if (bindings.has(bind)) throw new Error("Interactive binding collision");
          scenario.actions.push({ type: "send", mode: lastSend?.type === "send" ? lastSend.mode : undefined, bind, chat: lastSend?.type === "send" ? lastSend.chat : "main", text: `Additional context: ${text}\n\nOriginal binding requirements remain: ${scenario.objective.request}`, attachments: [], groundingEnabled: lastSend?.type === "send" ? lastSend.groundingEnabled : false }, { type: "settle", run: bind, approvals: lastSettle?.type === "settle" ? lastSettle.approvals : "read-only" });
          scenarioSchema.parse(scenario);
        }
      }
    }
    // Quiet observation window detects work continuing after terminal/cancel decisions.
    await pause(500, options.signal);
    persistence = await client.call("inspect", {}, 5000);
    for (const runId of bindings.values()) {
      const state = [...client.events].reverse().find((e) => e.event.runId === runId && e.event.type === "run_state");
      if (!state || state.event.type !== "run_state" || !terminalStates.has(state.event.state)) throw new Error("Scenario left an unsettled run");
    }
    relay.assertReplayComplete();
    if (relay.errors.length) throw new Error(relay.errors.join("; "));
  } catch (error) { healthError = String(error); }
  finally {
    options.signal?.removeEventListener("abort", interrupt);
    stopWatch?.();
    if (client) {
      await client.call("shutdown", {}, 3000).catch(() => undefined);
      terminateTree(client.child);
      await new Promise((r) => setTimeout(r, 50));
    }
    await relay.close();
  }
  try {
    const after = snapshot(box.workspace);
    for (const decision of client?.changes ?? []) if (decision.workspaceBefore && !decision.workspaceAfter) { decision.workspaceAfter = after; decision.endSequence = client?.events.length; }
    const artifacts: Record<string, string> = {};
    const artifactResults: ExecutionRecord["results"] = [];
    for (const envelope of client?.events ?? []) if (envelope.event.type === "artifact_ready") {
      const a = envelope.event.artifact;
      const root = a.relativePath.startsWith("runs/") ? box.data : box.workspace;
      try {
        const source = containedFile(root, a.relativePath);
        if (statSync(source).size > 32 * 1024 ** 2) throw new Error("Artifact exceeds raw evidence limit (32 MiB)");
        const saved = path.join(evidenceDir, "artifacts", a.runId, path.basename(a.filename));
        mkdirSync(path.dirname(saved), { recursive: true }); copyFileSync(source, saved);
        artifacts[`${a.runId}/${a.filename}`] = await parseArtifact(root, a.relativePath);
      } catch (error) {
        artifactResults.push({ id: `artifact-content-${a.artifactId}`, category: "task", verdict: String(error).includes("Unsupported artifact parser") ? "inconclusive" : "fail", message: `Registered artifact could not be verified: ${String(error)}`, evidence: a, severity: 10 });
      }
    }
    record = { version: 1, scenario, campaignId: options.campaignId, executionId, timestamp: new Date(started).toISOString(), commit, targetMode: options.mode, profile: options.profile, profileHash: profileHash(options.profile), modelMetadata: { versions: "unavailable", ...options.modelMetadata, wireRegistry: registry }, commands: client?.commands ?? [], responses: client?.responses ?? [], events: client?.events ?? [], traffic: relay.records, fixtureHashes, before, after, workspaceDiff: diff(before, after), artifactContents: artifacts, persistence, decisions: client?.changes ?? [], results: [], verdict: "inconclusive", healthError, durationMs: Date.now() - started, evidenceDir };
    record.runBindings = Object.fromEntries(bindings);
    record.interrupted = options.signal?.aborted || undefined;
    if (record.interrupted) record.healthError = "Execution interrupted by operator";
    record.attackerError = attackerError;
    record.results = [...artifactResults, ...(client?.behavioralFailures ?? []).map((c) => ({ ...c, category: "task" as const, verdict: "fail" as const, severity: 8 })), ...await evaluate(record, box, options.runtimeRoot, options.judge, options.signal)];
    if (options.signal?.aborted) { record.interrupted = true; record.healthError = "Execution interrupted by operator"; }
    const canaryEffects = diff(canaryBefore, existsSync(box.canary) ? snapshot(box.canary) : {});
    record.results.push({ id: "canary-integrity", category: "policy", verdict: canaryEffects.length ? "fail" : "pass", message: "Synthetic canary integrity", evidence: canaryEffects, severity: 15 });
    record.verdict = verdict(record.results);
    if (record.interrupted) record.verdict = "inconclusive";
    // Preserve changed code/artifacts for reproduction even after the sandbox is destroyed.
    mkdirSync(path.join(evidenceDir, "workspace"), { recursive: true });
    for (const [relative, entry] of Object.entries(after)) if (entry.kind === "file") { const output = path.join(evidenceDir, "workspace", relative); mkdirSync(path.dirname(output), { recursive: true }); copyFileSync(path.join(box.workspace, relative), output); }
    recorder.save(record);
    writeFileSync(path.join(evidenceDir, "scenario.json"), JSON.stringify(scenario, null, 2));
    return record;
  } finally { destroySandbox(box); }
}
