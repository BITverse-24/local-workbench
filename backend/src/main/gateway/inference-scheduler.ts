import type { ExecutionMode } from "../../shared/contracts.js";
import { abortError } from "../run/runtime-scope.js";

type Priority = ExecutionMode | "maintenance";
interface Ticket {
  mode: Priority;
  queuedAt: number;
  signal?: AbortSignal;
  grant: (release: () => void) => void;
  reject: (reason: unknown) => void;
  abort?: () => void;
}

/** Admission is non-preemptive. A lease includes consumption of the response body. */
export class InferenceScheduler {
  private readonly groups = new Map<string, { active: number; chatStreak: number; lastBackground: "work" | "agent"; queue: Ticket[] }>();
  constructor(private readonly capacity = 1, private readonly now = () => Date.now()) {}

  async acquire(mode: Priority, signal?: AbortSignal, group = "local-accelerator"): Promise<() => void> {
    signal?.throwIfAborted();
    const state = this.groups.get(group) ?? { active: 0, chatStreak: 0, lastBackground: "agent" as const, queue: [] };
    this.groups.set(group, state);
    return new Promise((grant, reject) => {
      const ticket: Ticket = { mode, signal, queuedAt: this.now(), grant, reject };
      ticket.abort = () => {
        const index = state.queue.indexOf(ticket);
        if (index >= 0) state.queue.splice(index, 1);
        reject(signal?.reason ?? abortError());
      };
      signal?.addEventListener("abort", ticket.abort, { once: true });
      state.queue.push(ticket);
      this.drain(group);
    });
  }

  async run<T>(mode: Priority, operation: () => Promise<T>, signal?: AbortSignal, group?: string): Promise<T> {
    const release = await this.acquire(mode, signal, group);
    try { signal?.throwIfAborted(); return await operation(); } finally { release(); }
  }

  private drain(group: string): void {
    const state = this.groups.get(group)!;
    while (state.active < this.capacity && state.queue.length) {
      const tasks = state.queue.filter(t => t.mode !== "maintenance");
      const candidates = tasks.length ? tasks : state.queue;
      let next = state.queue.find(t => this.now() - t.queuedAt >= 30000);
      if (!next) {
        const background = candidates.filter(t => t.mode === "work" || t.mode === "agent");
        const chat = candidates.find(t => t.mode === "chat");
        if (chat && (state.chatStreak < 3 || !background.length)) next = chat;
        else next = background.find(t => t.mode !== state.lastBackground) ?? background[0] ?? candidates[0];
      }
      state.queue.splice(state.queue.indexOf(next!), 1);
      next!.signal?.removeEventListener("abort", next!.abort!);
      if (next!.signal?.aborted) { next!.reject(next!.signal.reason ?? abortError()); continue; }
      state.active++;
      if (next!.mode === "chat") state.chatStreak++;
      else { state.chatStreak = 0; if (next!.mode === "work" || next!.mode === "agent") state.lastBackground = next!.mode; }
      let released = false;
      next!.grant(() => { if (released) return; released = true; state.active--; this.drain(group); });
    }
    if (!state.active && !state.queue.length) this.groups.delete(group);
  }
}

export const localInferenceScheduler = new InferenceScheduler();
export const fileProcessingSlots = new InferenceScheduler(2);
export const pythonProcessingSlots = new InferenceScheduler(1);
export const workspaceExecutionSlots = new InferenceScheduler(1);
