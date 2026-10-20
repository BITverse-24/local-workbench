import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { observedReplayState } from "./replay-observations.js";
import { canonicalRequest } from "./model-relay.js";
import type { EventEnvelope } from "./protocol.js";

function fixture(duration: number) {
  const runId = randomUUID(), resultId = randomUUID(), callId = randomUUID();
  const summary = `Command exit 0 in ${duration}ms; ran in isolation: test command`;
  const output = `[DURABLE RESULT: ${resultId}; retrieve_result action=read result_id=${resultId}]\n` + JSON.stringify({ exitCode: 0, stdout: "Source UUID: 11111111-2222-3333-4444-555555555555; pressure 12.7", stderr: `Ran 4 tests in 0.${duration}s`, durationMs: duration, verification: { runner: "unittest", executed: 4, failed: 0 } });
  const events: EventEnvelope[] = [{ version: 1, kind: "event", sequence: 1, timestamp: "2026-10-20T00:00:00Z", monotonicMs: 0, event: { type: "tool_result", tool: "run_command", runId, callId, output, summary, ok: true } }];
  const state = observedReplayState(events, "/generated/root");
  const request = { messages: [{ role: "system", content: `Completed operations: run_command: ${summary}\nStored result IDs: ${resultId}` }, { role: "user", content: `[Observed result from run_command]:\n${output}` }, { role: "user", content: '{"durationMs":27}; source 11111111-2222-3333-4444-555555555555' }], temperature: 0.2 };
  const canonical = (value = request) => canonicalRequest(value, state.identities, state.toolTelemetry, state.summaries);
  return { canonical, request };
}
describe("observed replay metadata", () => {
  it("matches new generated results and measured timings in native and JSON tool transport", () => {
    const a = fixture(15), b = fixture(39); expect(a.canonical()).toEqual(b.canonical());
    const native = (sample: ReturnType<typeof fixture>) => ({ ...sample.request, messages: sample.request.messages.map(message => message.content.startsWith("[Observed result from run_command]:\n") ? { role: "tool", content: message.content.slice("[Observed result from run_command]:\n".length) } : message) });
    expect(a.canonical(native(a))).toEqual(b.canonical(native(b)));
    expect(JSON.stringify(a.canonical())).toContain('11111111-2222-3333-4444-555555555555');
    expect(JSON.stringify(a.canonical())).toContain('durationMs\\\":27');
  });
  it("keeps source values, exit status and request changes observable", () => {
    const a = fixture(15), b = fixture(39);
    for (const replacement of ["pressure 99.9", "exitCode\":1", "source 99999999-2222-3333-4444-555555555555"]) {
      const changed = JSON.parse(JSON.stringify(b.request).replace(replacement.startsWith("pressure") ? "pressure 12.7" : replacement.startsWith("exitCode") ? 'exitCode\\\":0' : 'source 11111111-2222-3333-4444-555555555555', replacement.startsWith("exitCode") ? 'exitCode\\\":1' : replacement));
      expect(a.canonical()).not.toEqual(b.canonical(changed));
    }
    expect(a.canonical()).not.toEqual(b.canonical({ ...b.request, temperature: 0.4 }));
  });
});
