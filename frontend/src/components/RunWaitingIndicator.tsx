import { memo, useMemo, useState } from "react";
import AgentExecutionTimeline from "./AgentExecutionTimeline";
import { getRunProgress, type ProgressRow } from "../lib/run-progress";
import { assessedCheckLabel, TASK_STAGE_LABELS } from "../../../backend/src/shared/task-progress.js";

type Props = {
  isRunning: boolean;
  runState: RunState | null;
  activeRoute?: { taskType: string; modelId: string; reason: string } | null;
  runEvents?: RunEvent[];
  hasStreamingText?: boolean;
  onCancel?: () => void;
};

const EMPTY_EVENTS: RunEvent[] = [];

function ProgressSection({ title, rows, icon }: { title: string; rows: ProgressRow[]; icon: string }) {
  if (!rows.length) return null;
  return <div className="space-y-1.5">
    <dt className="text-xs font-semibold text-[var(--text-primary)]">{title}</dt>
    {rows.map((row, index) => <dd key={index} className="flex min-w-0 items-start gap-2 text-xs leading-relaxed text-[var(--text-secondary)]">
      <span aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]">{icon}</span>
      <span className="min-w-0 break-words">{row.label}{row.target && <>: <code className="break-all text-[var(--text-primary)]">{row.target}</code></>}
        {row.detail && <span className="block text-[var(--text-tertiary)]">{row.detail}</span>}</span>
    </dd>)}
  </div>;
}

const RunWaitingIndicator = memo(function RunWaitingIndicator({
  isRunning, runState, activeRoute, runEvents = EMPTY_EVENTS, hasStreamingText = false, onCancel,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const state = useMemo(() => getRunProgress(runEvents, runState), [runEvents, runState]);
  const activity = useMemo(() => runEvents.filter(event => event.type !== "model_progress"), [runEvents]);
  const results = activity.filter((event): event is Extract<RunEvent, { type: "tool_result" }> => event.type === "tool_result");
  const preview = state.paused ? undefined : state.progress?.preview?.trim();
  const showSkeleton = !state.paused && !preview && !(hasStreamingText && !state.task && !state.tool && (!state.progress || state.progress.channel === "text"));
  const kind = state.kind === "text" && activeRoute?.taskType === "code" ? "code" : state.kind;
  if (!isRunning) return null;

  return (
    <section className="run-waiting w-full max-w-2xl rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4" aria-label="Task activity">
      <div className="flex items-center gap-3">
        <span className={`run-activity-mark ${state.paused ? "is-paused" : ""}`} aria-hidden="true"><span /><span /><span /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--text-primary)]" role="status" aria-live="polite">{state.title}</p>
          <p className="mt-0.5 break-words text-xs text-[var(--text-tertiary)]">
            {state.paused ? "Review the proposed action to continue." : state.reasoning ? "Reasoning output received" : state.task ? "Progress from the current task" : state.tool?.summary || (state.progress?.status === "receiving" ? "Receiving model output" : "Waiting for the model response")}
          </p>
        </div>
        {onCancel && <button type="button" onClick={onCancel} className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]" aria-label="Stop task">Stop</button>}
      </div>
      <dl className="mt-3 space-y-3" aria-label="Progress summary">
        <ProgressSection title="Confirmed" rows={state.summary.confirmed} icon="✓" />
        <ProgressSection title="Now" rows={state.summary.now} icon="•" />
        <ProgressSection title="Still to check" rows={state.summary.remaining} icon="○" />
      </dl>
      {state.additionalTasks > 0 && <p className="mt-2 text-xs text-[var(--text-tertiary)]">{state.additionalTasks} additional {state.additionalTasks === 1 ? "task" : "tasks"} active</p>}
      {preview && <div className="mt-4 border-l-2 border-[var(--accent)] pl-3">
        <p className="mb-1.5 text-[11px] text-[var(--text-tertiary)]">Draft in progress</p>
        <p className="max-h-40 overflow-hidden whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--text-secondary)]">{preview}</p>
      </div>}
      {showSkeleton && <div className={`run-skeleton run-skeleton-${kind} mt-4 space-y-2.5`} aria-hidden="true">
        {kind === "document" && <div className="run-skeleton-line h-3.5 w-2/5 mb-4" />}
        {["82%", "64%", "91%", "46%"].map((width, index) => <div key={width} className="flex items-center gap-3">
          {kind === "code" && <span className="run-skeleton-line h-2 w-3 shrink-0 opacity-40" />}
          <span className="run-skeleton-line h-2.5" style={{ width, marginLeft: kind === "code" && index > 0 ? 12 : 0, animationDelay: `${index * 100}ms` }} />
        </div>)}
      </div>}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
        {(state.progress?.modelId || activeRoute?.modelId) && <span>{state.progress?.modelId || activeRoute?.modelId}</span>}
        {!state.paused && state.progress?.status === "receiving" && state.progress.outputChars > 0 && <span className="tabular-nums">{state.progress.outputChars.toLocaleString()} characters received</span>}
        {activity.some(event => event.type === "tool_call" || event.type === "agent_thinking" || event.type === "plan_step" || event.type === "task_progress") && <button type="button" className="ml-auto text-[var(--text-secondary)] hover:text-[var(--text-primary)]" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
          {expanded ? "Hide activity" : `Show activity${results.length ? ` · ${results.length} ${results.length === 1 ? "step" : "steps"}` : ""}`}
        </button>}
      </div>
      {expanded && <div className="mt-3 border-t border-[var(--border-subtle)] pt-2">
        {state.tasks.length > 0 && <ul className="mb-2 max-h-48 space-y-1.5 overflow-y-auto text-xs text-[var(--text-secondary)]" aria-label="Task stages">
          {state.tasks.map(task => <li key={task.activityId} className="break-words">
            <span aria-hidden="true">{task.status === "completed" ? "✓" : task.status === "blocked" ? "!" : "•"} </span>
            {task.status === "completed" ? TASK_STAGE_LABELS[task.stage].completed : TASK_STAGE_LABELS[task.stage].active}
            {task.target && <>: <code className="break-all">{task.target}</code></>}
            {assessedCheckLabel(task) && <span> · {assessedCheckLabel(task)}</span>}
            {task.status === "blocked" && task.reason && <p className="pl-3 text-[var(--text-tertiary)]">{task.reason}</p>}
          </li>)}
        </ul>}
        <AgentExecutionTimeline isRunning runState={runState} activeRoute={activeRoute} events={activity} defaultExpanded hideHeader compact />
      </div>}
    </section>
  );
});

export default RunWaitingIndicator;
