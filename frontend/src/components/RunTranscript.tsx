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

export default function RunTranscript({ events }: Props) {
  if (!events.length) return null;
  return (
    <div className="mx-4 my-2 rounded-xl neu-card p-3 max-h-[160px] overflow-y-auto">
      <div className="text-[11px] tracking-[0.12em] uppercase opacity-50 mb-2">Run transcript</div>
      <div className="space-y-1">
        {events.map((e, i) => (
          <div key={i} className="flex gap-2 text-xs leading-relaxed">
            <span className="opacity-40 shrink-0 w-4 text-center">{iconFor(e)}</span>
            <span className="opacity-80 break-words">{labelFor(e)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
