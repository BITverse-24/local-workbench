import type { EventEnvelope } from "./protocol.js";
import { toolObservation } from "./tool-observation.js";

/** Normalize host-generated identities and timing, never arbitrary source UUIDs. */
export function observedReplayState(events: EventEnvelope[], root: string) {
  const identities: Record<string, string> = { [root]: "<scenario-root>" };
  const toolTelemetry: Record<string, string> = {};
  const summaries: Record<string, string> = {};
  const groups = new Map<string, Set<string>>();
  const identity = (kind: string, value?: string) => {
    if (!value || identities[value]) return;
    const group = groups.get(kind) ?? new Set<string>();
    identities[value] = `<${kind}:${group.size}>`;
    group.add(value); groups.set(kind, group);
  };
  for (const { event } of events) {
    identity("run", event.runId);
    if (event.type === "tool_call" || event.type === "tool_result") identity("call", event.callId);
    if (event.type !== "tool_result") continue;
    const raw = event.output ?? "", observation = toolObservation(raw);
    identity("result", observation.resultId);
    if (event.tool === "write_file" && event.ok) {
      try {
        const value = JSON.parse(observation.payload);
        if (typeof value.backupPath === "string" && value.backupPath.startsWith(".harness_backups/")) identity("backup", value.backupPath.split("/").slice(0, 2).join("/"));
      } catch { /* A malformed observation stays exact. */ }
    }
    if (event.tool !== "run_command") continue;
    if (/^Command exit -?\d+ in \d+ms;/.test(event.summary)) summaries[`run_command: ${event.summary}`] = `run_command: ${event.summary.replace(/^(Command exit -?\d+ in )\d+ms;/, "$1<observed-command-duration>ms;")}`;
    try {
      const value = JSON.parse(observation.payload);
      if (!Number.isInteger(value.exitCode) || typeof value.durationMs !== "number" || typeof value.stdout !== "string" || typeof value.stderr !== "string") continue;
      value.durationMs = "<observed-command-duration>";
      if (value.verification?.runner === "unittest") value.stderr = value.stderr.replace(/^Ran (\d+ tests?) in \d+(?:\.\d+)?s$/gm, "Ran $1 in <observed-test-duration>s");
      const normalized = observation.prefix + JSON.stringify(value);
      toolTelemetry[raw] = normalized;
      toolTelemetry[`[Observed result from run_command]:\n${raw}`] = `[Observed result from run_command]:\n${normalized}`;
    } catch { /* Truncated or malformed reports are not rewritten. */ }
  }
  return { identities, toolTelemetry, summaries };
}
