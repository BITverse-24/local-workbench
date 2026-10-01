import { useState, useEffect, useMemo, useCallback, memo } from "react";

export interface ExecutionStep {
  id: string;
  tool: string;
  title: string;
  status: "running" | "completed" | "failed";
  resultSummary?: string;
  args?: Record<string, unknown>;
  output?: string;
  durationMs?: number;
}

interface Props {
  events?: RunEvent[];
  isRunning?: boolean;
  runState?: RunState | null;
  activeRoute?: { taskType: string; modelId: string; reason: string } | null;
  onCancel?: () => void;
  defaultExpanded?: boolean;
  compact?: boolean;
  totalDurationMs?: number;
}

function getToolIcon(tool: string) {
  const t = tool.toLowerCase();
  if (t === "read_file" || t === "ocr_extract" || t === "extract_document") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    );
  }
  if (t === "write_file" || t === "delete_file" || t === "draft_code") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    );
  }
  if (t === "search") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    );
  }
  if (t === "list_dir") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  if (t === "run_command" || t === "execute_python") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    );
  }
  if (t === "retrieve_sop" || t === "retrieve_knowledge") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    );
  }
  if (t === "inspect_drawing") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      </svg>
    );
  }
  if (t === "draft_note" || t === "generate_deliverable") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ToolBadge({
  step,
  isOpen,
  onToggle,
  copiedStepId,
  onCopy,
}: {
  step: ExecutionStep;
  isOpen: boolean;
  onToggle: () => void;
  copiedStepId: string | null;
  onCopy: (id: string, text: string) => void;
}) {
  const hasDetails = Boolean(step.args && Object.keys(step.args).length > 0) || Boolean(step.output);
  const isError = step.status === "failed";
  const isRunning = step.status === "running";

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => hasDetails && onToggle()}
        disabled={!hasDetails}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono transition-all select-none ${
          hasDetails ? "cursor-pointer hover:border-[var(--border-strong)]" : "cursor-default"
        } ${
          isRunning
            ? "bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-[var(--text-primary)] animate-pulse"
            : isError
            ? "bg-[var(--status-error)]/10 border border-[var(--status-error)]/30 text-[var(--status-error)]"
            : "bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-primary)] hover:bg-[var(--bg-surface)]"
        }`}
        title={step.title}
      >
        {/* Status indicator */}
        {isRunning ? (
          <span className="w-2.5 h-2.5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin shrink-0" />
        ) : isError ? (
          <span className="text-[var(--status-error)] text-[10px] font-bold shrink-0">✕</span>
        ) : (
          <span className="text-[var(--status-success)] text-[10px] font-bold shrink-0">✓</span>
        )}

        {/* Tool icon */}
        <span className="text-[var(--text-secondary)] shrink-0">
          {getToolIcon(step.tool)}
        </span>

        {/* Tool display summary */}
        <span className="truncate max-w-[260px] sm:max-w-[360px] font-medium">
          {step.resultSummary && !isRunning ? step.resultSummary : step.title}
        </span>

        {/* Duration */}
        {step.durationMs !== undefined && (
          <span className="text-[10px] text-[var(--text-tertiary)] font-normal shrink-0">
            {formatDuration(step.durationMs)}
          </span>
        )}

        {/* Chevron if details exist */}
        {hasDetails && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className={`text-[var(--text-tertiary)] transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {/* Expanded parameter & output preview */}
      {isOpen && hasDetails && (
        <div className="w-full max-w-xl border-l-2 border-[var(--border-subtle)] ml-3 pl-3 py-1.5 space-y-2 text-xs font-mono transition-all">
          {step.args && Object.keys(step.args).length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] font-semibold mb-0.5">
                Parameters
              </div>
              <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-secondary)] text-[11px] whitespace-pre-wrap break-all overflow-x-auto">
                {JSON.stringify(step.args, null, 2)}
              </pre>
            </div>
          )}

          {step.output && (
            <div>
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] font-semibold mb-0.5">
                <span>Output</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopy(step.id, step.output!);
                  }}
                  className="px-1.5 py-0.5 rounded-[var(--radius-sm)] hover:bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors normal-case"
                >
                  {copiedStepId === step.id ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-primary)] text-[11px] leading-relaxed whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                {step.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// PERF OPTIMIZATION: Memoize AgentExecutionTimeline component with React.memo.
// Prevents unnecessary component re-renders and virtual DOM tree diffs during streaming event updates
// when timeline props (events, isRunning, runState, activeRoute) have not changed.
const AgentExecutionTimeline = memo(function AgentExecutionTimeline({
  events = [],
  isRunning = false,
  runState = null,
  activeRoute = null,
  onCancel,
  defaultExpanded = true,
  compact = false,
  totalDurationMs,
}: Props) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [thinkingExpanded, setThinkingExpanded] = useState(isRunning);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [copiedStepId, setCopiedStepId] = useState<string | null>(null);

  // Live timer while running
  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 100);
    return () => clearInterval(timer);
  }, [isRunning]);

  // Aggregate thinking text across turns
  const thinkingText = useMemo(() => {
    const parts: string[] = [];
    for (const e of events) {
      if (e.type === "agent_thinking" && e.text) {
        parts.push(e.text.trim());
      }
    }
    return parts.join("\n\n");
  }, [events]);

  // Extract and correlate tool calls and results into coherent steps
  const steps = useMemo(() => {
    const stepMap = new Map<string, ExecutionStep>();
    const orderedIds: string[] = [];

    let anonymousIndex = 0;
    for (const e of events) {
      if (e.type === "tool_call") {
        anonymousIndex++;
        const id = (e as any).callId || `call-${anonymousIndex}-${e.tool}`;
        const step: ExecutionStep = {
          id,
          tool: e.tool,
          title: e.summary || `Executing ${e.tool}`,
          status: "running",
          args: (e as any).args,
        };
        stepMap.set(id, step);
        orderedIds.push(id);
      } else if (e.type === "tool_result") {
        const callId = (e as any).callId;
        let targetId = callId;
        if (!targetId) {
          for (let i = orderedIds.length - 1; i >= 0; i--) {
            const candidateId = orderedIds[i]!;
            const item = stepMap.get(candidateId);
            if (item && item.tool === e.tool && item.status === "running") {
              targetId = candidateId;
              break;
            }
          }
        }
        const isError =
          (e as any).ok !== undefined
            ? (e as any).ok === false
            : Boolean((e as any).output && String((e as any).output).startsWith("Error")) ||
              e.summary.toLowerCase().startsWith("error");
        if (targetId && stepMap.has(targetId)) {
          const prev = stepMap.get(targetId)!;
          stepMap.set(targetId, {
            ...prev,
            status: isError ? "failed" : "completed",
            resultSummary: e.summary,
            output: (e as any).output,
            durationMs: (e as any).durationMs,
          });
        } else {
          anonymousIndex++;
          const id = `res-${anonymousIndex}-${e.tool}`;
          stepMap.set(id, {
            id,
            tool: e.tool,
            title: e.summary,
            resultSummary: e.summary,
            status: isError ? "failed" : "completed",
            output: (e as any).output,
            durationMs: (e as any).durationMs,
          });
          orderedIds.push(id);
        }
      }
    }

    return orderedIds.map((id) => stepMap.get(id)!);
  }, [events]);

  // SOP Grounding context
  const groundingInfo = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type === "grounding_context") return e;
    }
    return null;
  }, [events]);

  // Plan steps if emitted
  const planSteps = useMemo(() => {
    const p: Array<{ index: number; text: string }> = [];
    for (const e of events) {
      if (e.type === "plan_step") {
        p.push({ index: e.index, text: e.text });
      }
    }
    return p.sort((a, b) => a.index - b.index);
  }, [events]);

  const handleCopyStep = useCallback((stepId: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedStepId(stepId);
    setTimeout(() => setCopiedStepId(null), 2000);
  }, []);

  const effectiveDuration = isRunning
    ? formatDuration(elapsedMs)
    : totalDurationMs
    ? formatDuration(totalDurationMs)
    : elapsedMs > 0
    ? formatDuration(elapsedMs)
    : "";

  const completedStepCount = steps.filter((s) => s.status === "completed").length;
  const runningStepCount = steps.filter((s) => s.status === "running").length;

  const effectiveTerminalState = useMemo(() => {
    if (runState) return runState;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "run_state") return e.state;
      if (e.type === "error") return "failed";
    }
    return "completed";
  }, [runState, events]);

  // Active status headline
  const headline = (() => {
    if (runState === "awaiting_confirmation") return "Awaiting confirmation";
    if (runningStepCount > 0) {
      const active = steps.find((s) => s.status === "running");
      return active ? active.title : "Executing tools...";
    }
    if (runState === "planning") return "Planning...";
    if (runState === "classifying") return "Analyzing...";
    if (runState === "acting") return "Executing...";
    if (isRunning) return "Thinking...";
    if (effectiveTerminalState === "limit_exceeded") return "Limit Exceeded";
    if (effectiveTerminalState === "partial") return "Partial";
    if (effectiveTerminalState === "failed") return "Failed";
    if (effectiveTerminalState === "cancelled") return "Cancelled";
    return "Complete";
  })();

  const modelId = activeRoute?.modelId ?? "agent-loop";

  // If there are no steps, no thinking, and not running, render nothing
  if (!isRunning && steps.length === 0 && !thinkingText && !compact) {
    return null;
  }

  // If completely idle with no history, return null
  if (!isRunning && steps.length === 0 && !thinkingText) {
    return null;
  }

  return (
    <div className={`w-full select-text transition-all duration-150 ${compact ? "my-1" : "my-2 max-w-[95%] sm:max-w-[85%]"}`}>
      {/* Top Badge-Level Status Row - NO CHUNKY BOX */}
      <div className="flex flex-wrap items-center gap-2 select-none mb-1.5">
        {/* Status indicator pill */}
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
          {isRunning ? (
            <>
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent)] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--accent)]" />
              </span>
              <span className="font-medium text-[var(--text-primary)]">{headline}</span>
            </>
          ) : (
            <>
              {effectiveTerminalState === "limit_exceeded" ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-[var(--status-warning)] shrink-0" />
                  <span className="text-[var(--status-warning)] font-medium">
                    {steps.length > 0 ? `${steps.length} ops • Limit Exceeded` : "Limit Exceeded"}
                  </span>
                </>
              ) : effectiveTerminalState === "partial" ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-[var(--status-warning)] shrink-0" />
                  <span className="text-[var(--status-warning)] font-medium">
                    {steps.length > 0 ? `${steps.length} ops • Partial` : "Partial"}
                  </span>
                </>
              ) : effectiveTerminalState === "failed" ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-[var(--status-error)] shrink-0" />
                  <span className="text-[var(--status-error)] font-medium">Failed</span>
                </>
              ) : effectiveTerminalState === "cancelled" ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-[var(--text-tertiary)] shrink-0" />
                  <span className="text-[var(--text-tertiary)]">Cancelled</span>
                </>
              ) : (
                <>
                  <span className="w-2 h-2 rounded-full bg-[var(--status-success)] shrink-0" />
                  <span>{steps.length > 0 ? `${steps.length} operation${steps.length === 1 ? "" : "s"}` : "Completed"}</span>
                </>
              )}
            </>
          )}

          {effectiveDuration && (
            <span className="text-[10px] text-[var(--text-tertiary)] font-mono ml-0.5">
              {effectiveDuration}
            </span>
          )}
        </div>

        {/* Model ID badge */}
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono text-[var(--text-tertiary)] bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
          {modelId}
        </span>

        {/* Stop button (when actively running) */}
        {isRunning && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-mono text-[var(--status-error)] hover:bg-[var(--status-error)]/10 border border-[var(--status-error)]/25 transition-colors"
            title="Stop execution"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
            <span>Stop</span>
          </button>
        )}

        {/* SOP Grounding Context Pill (if active) */}
        {groundingInfo && (
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--accent)]">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span className="truncate max-w-[280px]">
              {groundingInfo.status === "retrieving"
                ? "Querying SOP criteria..."
                : groundingInfo.status === "injected"
                ? `${groundingInfo.chunkCount ?? 0} SOP clauses`
                : "No SOP clauses"}
            </span>
          </div>
        )}

        {/* Toggle Expand / Collapse */}
        {(steps.length > 0 || thinkingText) && (
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-raised)] transition-colors"
            title={isExpanded ? "Collapse activity" : "Expand activity"}
            aria-label={isExpanded ? "Collapse activity" : "Expand activity"}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>

      {/* Execution Content (Badges Flow) - NO OUTER CARD */}
      {isExpanded && (
        <div className="space-y-2 pt-1">
          {/* Thinking / Scratchpad Pill */}
          {thinkingText && (
            <div className="flex flex-col items-start gap-1">
              <button
                type="button"
                onClick={() => setThinkingExpanded(!thinkingExpanded)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono bg-[var(--bg-surface-raised)] hover:bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all select-none"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--accent)] shrink-0">
                  <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
                  <path d="M9 21h6" />
                </svg>
                <span>{isRunning ? "Thinking..." : "Thought process"}</span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className={`text-[var(--text-tertiary)] transition-transform shrink-0 ${thinkingExpanded ? "rotate-180" : ""}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {thinkingExpanded && (
                <div className="w-full max-w-2xl border-l-2 border-[var(--accent)]/40 ml-3 pl-3 py-1.5 my-0.5 text-xs font-mono text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap max-h-56 overflow-y-auto">
                  {thinkingText}
                </div>
              )}
            </div>
          )}

          {/* Plan Steps Checklist */}
          {planSteps.length > 1 && (
            <div className="space-y-1 py-1 pl-1">
              {planSteps.map((s, idx) => {
                const isDone = completedStepCount > idx;
                const isCurrent = runningStepCount > 0 && completedStepCount === idx;
                return (
                  <div key={idx} className="flex items-center gap-2 text-xs font-mono">
                    {isDone ? (
                      <span className="text-[var(--status-success)] font-bold text-[10px]">✓</span>
                    ) : isCurrent ? (
                      <span className="w-2.5 h-2.5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <span className="text-[var(--text-tertiary)] text-[10px]">○</span>
                    )}
                    <span className={isDone ? "text-[var(--text-tertiary)] line-through" : isCurrent ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]"}>
                      {s.text}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Tool Calls List - Pure Badge Chips */}
          {steps.length > 0 && (
            <div className="flex flex-col items-start gap-1.5">
              {steps.map((step) => (
                <ToolBadge
                  key={step.id}
                  step={step}
                  isOpen={expandedStepId === step.id}
                  onToggle={() => setExpandedStepId(expandedStepId === step.id ? null : step.id)}
                  copiedStepId={copiedStepId}
                  onCopy={handleCopyStep}
                />
              ))}
            </div>
          )}

          {/* Confirmation Required Alert Badge */}
          {runState === "awaiting_confirmation" && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-mono bg-[var(--status-warning)]/15 border border-[var(--status-warning)]/30 text-[var(--status-warning)] animate-pulse">
              <span className="w-2 h-2 rounded-full bg-[var(--status-warning)] shrink-0" />
              <span>Approval required. Please review the action prompt above.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default AgentExecutionTimeline;
