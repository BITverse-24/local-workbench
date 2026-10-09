import type { TaskProgressEvent } from "../../shared/contracts.js";
import { assessedCheckLabel, TASK_STAGE_LABELS } from "../../shared/task-progress.js";

export interface PartialResultEvidence {
  savedFiles: string[];
  executions: Array<{ target?: string; exitCode: number }>;
  checkpoints: TaskProgressEvent[];
  missing: string[];
  verificationFailures: string[];
  verificationPending?: string[];
  workspaceOperations?: Array<{ operation: "write" | "delete"; target: string }>;
  stopReason?: string;
}

const literal = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&");
const filename = (text: string) => text.includes("`") ? literal(text) : `\`${text.replace(/[\r\n]+/g, " ")}\``;

/** Fixed text over runtime evidence; never infers acceptance from execution or output size. */
export function formatPartialResult(details: string, evidence: PartialResultEvidence, maxChars = Infinity): string {
  const confirmed = [
    ...evidence.savedFiles.map(file => `File saved: ${filename(file)}.`),
    ...evidence.executions.filter(execution => execution.exitCode === 0)
      .map(execution => `Execution succeeded (exit code 0)${execution.target ? `: ${filename(execution.target)}` : ""}.`),
    ...(evidence.workspaceOperations ?? []).map(item => `Workspace ${item.operation === "write" ? "write" : "deletion"} completed: ${filename(item.target)}.`),
  ];
  // Keep the latest checkpoint for each stage and target; an older revision cannot describe this one.
  const latest = new Map<string, TaskProgressEvent>();
  for (const event of evidence.checkpoints) {
    const key = `${event.stage}:${event.target ?? ""}`;
    latest.delete(key); latest.set(key, event);
  }
  const blocked = [...latest.values()].filter(event => event.status === "blocked");
  const remaining = [
    ...[...latest.values()].filter(event => event.status !== "completed").map(event => {
      const count = assessedCheckLabel(event);
      return `${TASK_STAGE_LABELS[event.stage].remaining}${event.target ? `: ${filename(event.target)}` : ""}${count ? ` — ${count}` : ""}.`;
    }),
    ...evidence.missing.map(requirement => `Requested work: ${literal(requirement)}.`),
    ...evidence.verificationFailures.map(requirement => `Verification: ${literal(requirement)}.`),
    ...(evidence.verificationPending ?? []).map(requirement => `Acceptance not yet verified: ${literal(requirement)}.`),
  ];
  const section = (title: string, rows: string[]) => {
    const unique = [...new Set(rows)];
    if (!unique.length) return "";
    return `**${title}**\n\n${unique.slice(0, 3).map(row => `- ${row}`).join("\n")}${unique.length > 3 ? `\n- ${unique.length - 3} additional items; see details.` : ""}\n\n`;
  };
  const reason = evidence.stopReason || blocked[blocked.length - 1]?.reason || "Not all requested work was confirmed.";
  const prefix = `**Partially complete**\n\n${section("Confirmed", confirmed)}${section("Still to check", remaining)}**Why it stopped:** ${literal(reason)}\n\n**Details**\n\n`;
  if (prefix.length + details.length <= maxChars) return prefix + details;
  const notice = "\n\n[Details shortened to fit the saved message limit.]";
  return prefix + details.slice(0, Math.max(0, maxChars - prefix.length - notice.length)) + notice;
}
