import { memo, useMemo } from "react";
import { assessedCheckLabel, TASK_STAGE_LABELS } from "../../../backend/src/shared/task-progress.js";

type Props = { events: RunEvent[] };

function iconFor(e: RunEvent): string {
  switch (e.type) {
    case "run_state": return "●";
    case "task_progress": return e.status === "blocked" ? "!" : e.status === "completed" ? "✓" : "•";
    case "routing": return "↗";
    case "plan_step": return "▣";
    case "agent_thinking": return "💭";
    case "tool_call": return "▶";
    case "tool_result": return (e as any).ok === false ? "✕" : "✓";
    case "context_compaction": return "✂";
    case "confirmation_required": return "◉";
    case "artifact_ready": return "⬢";
    case "assistant_message": return "✎";
    case "error": return "✕";
    default: return "·";
  }
}

function labelFor(e: RunEvent): string {
  switch (e.type) {
    case "run_state": return `state: ${e.state}`;
    case "task_progress": return `${e.status === "completed" ? TASK_STAGE_LABELS[e.stage].completed : TASK_STAGE_LABELS[e.stage].active}${e.target ? `: ${e.target}` : ""}${assessedCheckLabel(e) ? ` · ${assessedCheckLabel(e)}` : ""}${e.status === "blocked" && e.reason ? ` — ${e.reason}` : ""}`;
    case "routing": return `Model selected: ${e.modelId} (${e.reason})`;
    case "plan_step": return e.text;
    case "agent_thinking": return (e as any).text ? String((e as any).text).slice(0, 140) : "Thinking...";
    case "tool_call": return `${e.tool}: ${e.summary}`;
    case "tool_result": return `${e.tool}: ${e.summary}`;
    case "context_compaction": return `Compacted ${(e as any).metadata?.toolName || "observation"} (${(e as any).metadata?.retainedChars}/${(e as any).metadata?.originalChars} chars)`;
    case "confirmation_required": return `${e.action.prompt} [${e.action.kind}]`;
    case "artifact_ready": return `${e.artifact.filename} (${e.artifact.kind})`;
    case "assistant_message": return e.text.slice(0, 120);
    case "error": return `${e.code}: ${e.message}`;
    default: return (e as any).summary || (e as any).text || (e as any).name || "";
  }
}

// PERF OPTIMIZATION: Memoize RunTranscript and its event label/icon array mapping.
// Prevents recalculating label strings and icons across the entire events array on every minor stream tick or parent component re-render.
const RunTranscript = memo(function RunTranscript({ events }: Props) {
  const visibleEvents = useMemo(() => {
    return events.filter((e) => (e as any).type !== "workspace_tree" && e.type !== "model_progress");
  }, [events]);

  const formattedEvents = useMemo(() => {
    return visibleEvents.map((e) => ({
      icon: iconFor(e),
      label: labelFor(e),
    }));
  }, [visibleEvents]);

  if (!visibleEvents.length) return null;
  return (
    <div className="mx-4 my-2 rounded-[var(--radius-md)] neu-card border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 max-h-[160px] overflow-y-auto select-text">
      <div className="text-xs font-medium text-[var(--text-secondary)] mb-2 select-none">Run transcript</div>
      <div className="space-y-1 select-text">
        {formattedEvents.map((e, i) => (
          <div key={i} className="flex gap-2 text-xs leading-relaxed select-text">
            <span className="text-[var(--text-tertiary)] shrink-0 w-4 text-center font-mono select-none">{e.icon}</span>
            <span className="text-[var(--text-secondary)] break-words select-text">{e.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

export default RunTranscript;
