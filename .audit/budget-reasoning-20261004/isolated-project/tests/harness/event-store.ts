import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import type { RunEvent } from "../../backend/src/shared/contracts.js";
import { terminalStates, type EventEnvelope } from "./protocol.js";

export class EventStore {
  readonly events: EventEnvelope[] = [];
  private emitter = new EventEmitter();
  private started = performance.now();
  constructor(private output: (event: EventEnvelope) => void) { this.emitter.setMaxListeners(100); }
  push(event: RunEvent): void {
    const envelope: EventEnvelope = { version: 1, kind: "event", sequence: this.events.length + 1, timestamp: new Date().toISOString(), monotonicMs: performance.now() - this.started, event };
    this.events.push(envelope); this.output(envelope); this.emitter.emit("event", envelope);
  }
  wait(runId: string, type: string, state: string | undefined, after: number, timeoutMs: number): Promise<EventEnvelope> {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.emitter.off("event", onEvent); this.emitter.off("close", onClose); };
      const onClose = () => { cleanup(); reject(new Error("Worker shutting down")); };
      const onEvent = (entry: EventEnvelope) => {
        if (entry.sequence <= after || entry.event.runId !== runId) return;
        const event = entry.event;
        if (event.type === type && (!state || ("state" in event && event.state === state))) { cleanup(); resolve(entry); }
        else if (event.type === "run_state" && terminalStates.has(event.state)) { cleanup(); reject(new Error(`Unexpected terminal state: ${event.state}`)); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("Event wait timed out")); }, timeoutMs);
      this.emitter.on("event", onEvent); this.emitter.on("close", onClose);
      for (const entry of this.events) onEvent(entry);
    });
  }
  close(): void { this.emitter.emit("close"); }
}
