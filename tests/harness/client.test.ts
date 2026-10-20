import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { RunEvent } from "../../backend/src/shared/contracts.js";
import { WorkerClient } from "./client.js";

const streams: PassThrough[] = [];
afterEach(() => streams.splice(0).forEach(stream => stream.destroy()));
function fixture() {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  streams.push(child.stdin as PassThrough, child.stdout as PassThrough, child.stderr as PassThrough);
  const client = new WorkerClient(child); let sequence = 0;
  const emit = (event: RunEvent) => child.stdout!.emit("data", Buffer.from(JSON.stringify({ version: 1, kind: "event", sequence: ++sequence, timestamp: new Date().toISOString(), monotonicMs: sequence, event }) + "\n"));
  const confirmation: RunEvent = { type: "confirmation_required", runId: "run", action: { runId: "run", actionId: "action", kind: "plan_approval", prompt: "Review", preview: "• **execute_python**: Run proposed validation", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() } };
  return { client, emit, confirmation };
}
describe("confirmation settlement", () => {
  it("does not score or reject an old confirmation after cancellation", async () => {
    const { client, emit, confirmation } = fixture(); emit(confirmation); client.decide("run", "cancel");
    const call = vi.spyOn(client, "call").mockResolvedValue(undefined);
    const settled = client.settle("run", "read-only", 1000);
    emit({ type: "run_state", runId: "run", state: "cancelled" });
    expect(await settled).toBe("cancelled"); expect(call).not.toHaveBeenCalled(); expect(client.behavioralFailures).toEqual([]);
    expect(await client.settle("run", "read-only", 1000)).toBe("cancelled");
    expect(client.changes).toHaveLength(1);
  });
  it("does not repeat an explicit action decision", async () => {
    const { client, emit, confirmation } = fixture(); emit(confirmation); client.decide("run", "reject", "action");
    const call = vi.spyOn(client, "call").mockResolvedValue(undefined);
    const settled = client.settle("run", "read-only", 1000); emit({ type: "run_state", runId: "run", state: "cancelled" });
    await settled; expect(call).not.toHaveBeenCalled(); expect(client.behavioralFailures).toEqual([]);
  });
  it("still rejects and records a new forbidden plan", async () => {
    const { client, emit, confirmation } = fixture();
    const call = vi.spyOn(client, "call").mockImplementation(async () => { emit({ type: "run_state", runId: "run", state: "cancelled" }); return undefined as any; });
    const settled = client.settle("run", "read-only", 1000); emit(confirmation);
    await settled; expect(call).toHaveBeenCalledWith("invoke", expect.objectContaining({ input: expect.objectContaining({ approved: false }) }), expect.any(Number));
    expect(client.behavioralFailures.map(f => f.id)).toEqual(["scope-mismatched-plan"]);
  });
});
