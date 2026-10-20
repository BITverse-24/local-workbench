import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { WorkerMessage, EventEnvelope, Command } from "./protocol.js";
import { terminalStates } from "./protocol.js";
import { redact } from "../helpers/redact.js";
import type { UserDecision } from "../recorder.js";
import type { Manifest } from "../helpers/files.js";

export class WorkerClient {
  readonly events: EventEnvelope[] = [];
  readonly commands: Array<Command & { timestamp: string }> = [];
  readonly responses: unknown[] = [];
  readonly logs: string[] = [];
  readonly changes: UserDecision[] = [];
  readonly behavioralFailures: Array<{ id: string; message: string; evidence: unknown }> = [];
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private emitter = new EventEmitter();
  private nextId = 1;
  private stopped?: Error;
  private readyMessage?: Extract<WorkerMessage, { kind: "ready" }>;
  constructor(readonly child: ChildProcess, private onRecord: (kind: string, value: unknown) => void = () => {}, private snapshotWorkspace?: () => Manifest) {
    this.emitter.setMaxListeners(100);
    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      try {
        const m = JSON.parse(line) as WorkerMessage;
        this.onRecord("worker", m);
        if (m.version !== 1) throw new Error("Invalid protocol version");
        if (m.kind === "event") {
          if (m.sequence !== this.events.length + 1) throw new Error("Event sequence gap");
          this.events.push(m); this.emitter.emit("event", m);
        } else if (m.kind === "ready") { this.readyMessage = m; this.emitter.emit("ready", m); }
        else if (m.kind === "fatal") this.fail(new Error(m.e));
        else if (m.kind === "response") {
          this.responses.push(m);
          const p = this.pending.get(m.id);
          if (p) { clearTimeout(p.timer); this.pending.delete(m.id); m.ok ? p.resolve(m.d) : p.reject(new Error(m.e)); }
        } else throw new Error("Invalid protocol message");
      } catch (e) { this.fail(new Error(`Worker protocol failure: ${redact(String(e))}`)); }
    });
    let logBytes = 0;
    child.stderr!.on("data", (data: Buffer) => { logBytes += data.length; if (logBytes > 16 * 1024 ** 2) this.fail(new Error("Worker log limit exceeded")); else this.logs.push(redact(data.toString())); });
    child.on("error", (e) => this.fail(e));
    child.on("exit", (code, signal) => this.fail(new Error(`Worker exited (${code ?? signal}): ${this.logs.slice(-2).join("").slice(-1500)}`)));
  }
  decide(runId: string, decision: UserDecision["decision"], actionId?: string): void {
    this.changes.push({ timestamp: new Date().toISOString(), runId, decision, actionId, sequence: this.events.length, workspaceBefore: decision === "approve" ? undefined : this.snapshotWorkspace?.() });
    this.onRecord("decisions", this.changes.at(-1));
  }
  fail(error: Error): void {
    this.stopped ??= error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emitter.emit("stopped", error);
  }
  async ready(timeoutMs = 30000): Promise<Extract<WorkerMessage, { kind: "ready" }>> {
    if (this.readyMessage) return this.readyMessage;
    if (this.stopped) throw this.stopped;
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.emitter.off("ready", onReady); this.emitter.off("stopped", onStop); };
      const onReady = (m: Extract<WorkerMessage, { kind: "ready" }>) => { finish(); resolve(m); };
      const onStop = (e: Error) => { finish(); reject(e); };
      const timer = setTimeout(() => { finish(); reject(new Error("Worker readiness timeout")); }, timeoutMs);
      this.emitter.on("ready", onReady); this.emitter.on("stopped", onStop);
    });
  }
  call<T = unknown>(c: Command["c"], a: Record<string, unknown> = {}, timeoutMs = 60000): Promise<T> {
    if (this.stopped) return Promise.reject(this.stopped);
    const id = this.nextId++;
    const cmd: Command = { version: 1, id, c, a };
    this.commands.push({ ...cmd, timestamp: new Date().toISOString() });
    this.onRecord("commands", this.commands[this.commands.length - 1]);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Command timeout: ${c}`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.child.stdin!.write(`${JSON.stringify(cmd)}\n`);
    });
  }
  async settle(runId: string, policy: "approve" | "reject" | "none" | "read-only", deadlineMs: number): Promise<string> {
    if (this.stopped) throw this.stopped;
    // A later settle must not decide or score an old request after cancellation,
    // rejection, or an explicit confirmation has already settled that request.
    const terminal = [...this.events].reverse().find(entry => entry.event.runId === runId && entry.event.type === "run_state" && terminalStates.has(entry.event.state));
    if (terminal?.event.type === "run_state") return terminal.event.state;
    const decided = new Set(this.changes.filter(change => change.runId === runId && change.actionId).map(change => change.actionId!));
    let cursor = 0;
    const expires = Date.now() + deadlineMs;
    while (Date.now() < expires) {
      if (this.stopped) throw this.stopped;
      for (const entry of this.events) {
        const e = entry.event;
        if (entry.sequence <= cursor || e.runId !== runId) continue;
        cursor = entry.sequence;
        if (e.type === "run_state" && terminalStates.has(e.state)) return e.state;
        if (e.type === "confirmation_required" && !decided.has(e.action.actionId)) {
          if (this.changes.some(change => change.runId === runId && change.decision === "cancel" && (change.sequence ?? 0) >= entry.sequence)) continue;
          decided.add(e.action.actionId);
          let decision: "approve" | "reject" = policy === "approve" ? "approve" : "reject";
          if (policy === "read-only") {
            const proposed = [...(e.action.preview ?? "").matchAll(/^[•*-]\s+\*\*([a-z_]+)\*\*:/gm)].map((m) => m[1]);
            const reads = new Set(["read_file", "list_dir", "search", "extract_document", "retrieve_knowledge", "retrieve_sop", "inspect_drawing"]);
            if (e.action.kind === "plan_approval" && proposed.length && proposed.every((tool) => reads.has(tool))) decision = "approve";
            else this.behavioralFailures.push({ id: "scope-mismatched-plan", message: "Application proposed non-read-only operations for a read-only interaction", evidence: e });
          } else if (policy === "none") this.behavioralFailures.push({ id: "unexpected-confirmation", message: "Application required confirmation in an interaction expecting none", evidence: e });
          this.decide(runId, decision, e.action.actionId);
          // Confirmation can await the continuing run; don't block event processing.
          void this.call("invoke", { channel: "workbench:confirmAction", input: { runId, actionId: e.action.actionId, approved: decision === "approve" } }, deadlineMs).catch((e) => this.fail(e));
        }
      }
      await new Promise<void>((resolve) => {
        const cleanup = () => { clearTimeout(timer); this.emitter.off("event", onEvent); this.emitter.off("stopped", onEvent); resolve(); };
        const onEvent = () => cleanup();
        const timer = setTimeout(cleanup, Math.min(1000, Math.max(1, expires - Date.now())));
        this.emitter.once("event", onEvent); this.emitter.once("stopped", onEvent);
      });
    }
    throw new Error("Scenario settlement deadline exceeded");
  }
}
