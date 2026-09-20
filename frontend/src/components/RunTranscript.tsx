import { memo, useMemo } from "react";

type Props = { events: RunEvent[] };

function iconFor(e: RunEvent): string {
  switch (e.type) {
    case "run_state": return "●";
    case "routing": return "↗";
    case "plan_step": return "▣";
    case "tool_call": return "▶";
    case "tool_result": return "✓";
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
    case "routing": return `${e.taskType} → ${e.modelId} (${e.reason})`;
    case "plan_step": return e.text;
    case "tool_call": return `${e.tool}: ${e.summary}`;
    case "tool_result": return `${e.tool}: ${e.summary}`;
    case "confirmation_required": return `${e.action.prompt} [${e.action.kind}]`;
    case "artifact_ready": return `${e.artifact.filename} (${e.artifact.kind})`;
    case "assistant_message": return e.text.slice(0, 120);
    case "error": return `${e.code}: ${e.message}`;
    default: return "";
  }
}

// PERF OPTIMIZATION: Memoize RunTranscript and its event label/icon array mapping.
// Prevents recalculating label strings and icons across the entire events array on every minor stream tick or parent component re-render.
const RunTranscript = memo(function RunTranscript({ events }: Props) {
  const formattedEvents = useMemo(() => {
    return events.map((e) => ({
      icon: iconFor(e),
      label: labelFor(e),
    }));
  }, [events]);

  if (!events.length) return null;
  return (
    <div className="mx-4 my-2 rounded-[var(--radius-md)] neu-card border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 max-h-[160px] overflow-y-auto">
      <div className="text-xs font-medium text-[var(--text-secondary)] mb-2">Run transcript</div>
      <div className="space-y-1">
        {formattedEvents.map((e, i) => (
          <div key={i} className="flex gap-2 text-xs leading-relaxed">
            <span className="text-[var(--text-tertiary)] shrink-0 w-4 text-center font-mono">{e.icon}</span>
            <span className="text-[var(--text-secondary)] break-words">{e.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

export default RunTranscript;
