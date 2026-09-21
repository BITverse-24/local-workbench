import { useState, useEffect, useMemo, useCallback } from "react";

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
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    );
  }
  if (t === "search") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    );
  }
  if (t === "list_dir") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    );
  }
  if (t === "run_command" || t === "execute_python") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    );
  }
  if (t === "retrieve_sop" || t === "retrieve_knowledge") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    );
  }
  if (t === "inspect_drawing") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      </svg>
    );
  }
  if (t === "draft_note" || t === "generate_deliverable") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function AgentExecutionTimeline({
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
        // Try match by callId or by latest running tool matching name
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
        if (targetId && stepMap.has(targetId)) {
          const prev = stepMap.get(targetId)!;
          const isError =
            Boolean((e as any).output && String((e as any).output).startsWith("Error")) ||
            e.summary.toLowerCase().startsWith("error");
          stepMap.set(targetId, {
            ...prev,
            status: isError ? "failed" : "completed",
            resultSummary: e.summary,
            output: (e as any).output,
            durationMs: (e as any).durationMs,
          });
        } else {
          // Unmatched result - record as standalone completed step
          anonymousIndex++;
          const id = `res-${anonymousIndex}-${e.tool}`;
          stepMap.set(id, {
            id,
            tool: e.tool,
            title: e.summary,
            resultSummary: e.summary,
            status: "completed",
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

  // Active status headline
  const headline = (() => {
    if (runState === "awaiting_confirmation") return "Awaiting your approval...";
    if (runningStepCount > 0) {
      const active = steps.find((s) => s.status === "running");
      return active ? active.title : "Executing tools...";
    }
    if (runState === "planning") return "Formulating execution plan...";
    if (runState === "classifying") return "Analyzing task intent...";
    if (runState === "acting") return "Executing agent workflow...";
    if (isRunning) return "Thinking...";
    return "Task completed";
  })();

  const modelId = activeRoute?.modelId ?? "agent-loop";
  const taskType = activeRoute?.taskType ?? "code";

  // If there are no steps, no thinking, and not running, render nothing
  if (!isRunning && steps.length === 0 && !thinkingText && !compact) {
    return null;
  }

  return (
    <div
      className={`w-full transition-all duration-200 select-text ${
        compact
          ? "my-1.5"
          : "my-3 max-w-[92%] md:max-w-[82%]"
      }`}
    >
      <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden shadow-xs">
        {/* Top Control & Status Bar */}
        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-[var(--bg-surface-raised)]/60 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Pulsing indicator while running / Checkmark when done */}
            {isRunning ? (
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent)] opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--accent)]" />
              </span>
            ) : (
              <span className="w-2 h-2 rounded-full bg-[var(--status-success)] shrink-0" />
            )}

            {/* Model & Modality Tags */}
            <div className="flex items-center gap-2 truncate">
              <span className="text-xs font-mono text-[var(--text-primary)] font-medium truncate">
                {modelId}
              </span>
              <span className="px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[10px] font-mono uppercase tracking-wider bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] shrink-0">
                {taskType}
              </span>
            </div>

            {/* Status summary pill */}
            <span className="text-xs text-[var(--text-secondary)] truncate hidden sm:inline">
              {isRunning ? headline : `${steps.length} operation${steps.length === 1 ? "" : "s"} executed`}
            </span>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {effectiveDuration && (
              <span className="font-mono text-[11px] text-[var(--text-tertiary)]">
                {effectiveDuration}
              </span>
            )}

            {isRunning && onCancel && (
              <button
                onClick={onCancel}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] hover:bg-[var(--status-error)]/15 hover:border-[var(--status-error)]/30 border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--status-error)] transition-colors"
                title="Stop execution"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
                <span>Stop</span>
              </button>
            )}

            {/* Expand / Collapse Full Step History */}
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="p-1 rounded-[var(--radius-sm)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors"
              title={isExpanded ? "Collapse activity" : "Expand activity"}
              aria-label={isExpanded ? "Collapse activity" : "Expand activity"}
            >
              <svg
                width="14"
                height="14"
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
          </div>
        </div>

        {/* SOP Grounding Context Banner (if active) */}
        {groundingInfo && (
          <div className="px-3.5 py-1.5 bg-[var(--bg-surface)]/50 border-b border-[var(--border-subtle)] flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-[var(--accent)]">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span className="truncate">
              {groundingInfo.status === "retrieving"
                ? "Querying local knowledge base for governing SOP criteria..."
                : groundingInfo.status === "injected"
                ? `Grounded in ${groundingInfo.chunkCount ?? 0} retrieved SOP specification clauses`
                : "No matching SOP clauses retrieved"}
            </span>
          </div>
        )}

        {/* Collapsible Content Area */}
        {isExpanded && (
          <div className="p-3.5 space-y-2.5">
            {/* Streamed / Collapsible Reasoning Block ("Thinking") */}
            {thinkingText && (
              <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-raised)]/40 overflow-hidden">
                <button
                  onClick={() => setThinkingExpanded(!thinkingExpanded)}
                  className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-[var(--bg-surface-raised)]/70 transition-colors"
                >
                  <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--accent)]">
                      <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
                      <path d="M9 21h6" />
                    </svg>
                    <span>{isRunning ? "Reasoning & scratchpad" : "Agent reasoning trace"}</span>
                  </div>
                  <span className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-1 font-mono">
                    <span>{thinkingExpanded ? "Hide" : "Show"}</span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className={`transition-transform ${thinkingExpanded ? "rotate-180" : ""}`}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </span>
                </button>
                {thinkingExpanded && (
                  <div className="px-3 py-2.5 border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)]/60 text-xs font-mono text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {thinkingText}
                  </div>
                )}
              </div>
            )}

            {/* Plan Steps Checklist (if multi-step plan exists) */}
            {planSteps.length > 1 && (
              <div className="space-y-1.5 py-1">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
                  Execution Plan
                </div>
                <div className="space-y-1 pl-1">
                  {planSteps.map((s, idx) => {
                    const isDone = completedStepCount > idx;
                    const isCurrent = runningStepCount > 0 && completedStepCount === idx;
                    return (
                      <div key={idx} className="flex items-center gap-2 text-xs">
                        {isDone ? (
                          <span className="w-4 h-4 rounded-full bg-[var(--status-success)]/15 text-[var(--status-success)] flex items-center justify-center text-[10px] font-bold">
                            ✓
                          </span>
                        ) : isCurrent ? (
                          <span className="w-4 h-4 rounded-full border border-[var(--accent)] text-[var(--accent)] flex items-center justify-center text-[10px] animate-spin">
                            ⟳
                          </span>
                        ) : (
                          <span className="w-4 h-4 rounded-full border border-[var(--border-subtle)] text-[var(--text-tertiary)] flex items-center justify-center text-[10px]">
                            ○
                          </span>
                        )}
                        <span className={isDone ? "text-[var(--text-secondary)] line-through" : isCurrent ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-tertiary)]"}>
                          {s.text}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Real Tool Calls Timeline */}
            {steps.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] flex items-center justify-between">
                  <span>Tool Calls ({steps.length})</span>
                  {runningStepCount > 0 && (
                    <span className="text-[10px] text-[var(--accent)] font-mono animate-pulse">
                      Active: {runningStepCount}
                    </span>
                  )}
                </div>

                <div className="space-y-1">
                  {steps.map((step) => {
                    const isStepOpen = expandedStepId === step.id;
                    const hasDetails = Boolean(step.args || step.output || step.resultSummary);

                    return (
                      <div
                        key={step.id}
                        className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-raised)]/50 transition-colors overflow-hidden"
                      >
                        {/* Step Row Header */}
                        <div
                          onClick={() => hasDetails && setExpandedStepId(isStepOpen ? null : step.id)}
                          className={`px-3 py-2 flex items-center justify-between gap-2 text-xs select-none ${
                            hasDetails ? "cursor-pointer hover:bg-[var(--bg-surface-raised)]" : ""
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            {/* Status Icon */}
                            {step.status === "running" ? (
                              <span className="w-3.5 h-3.5 border-2 border-[var(--border-default)] border-t-[var(--accent)] rounded-full animate-spin shrink-0" />
                            ) : step.status === "completed" ? (
                              <span className="w-3.5 h-3.5 rounded-full bg-[var(--status-success)]/20 text-[var(--status-success)] grid place-items-center text-[9px] font-bold shrink-0">
                                ✓
                              </span>
                            ) : (
                              <span className="w-3.5 h-3.5 rounded-full bg-[var(--status-error)]/20 text-[var(--status-error)] grid place-items-center text-[9px] font-bold shrink-0">
                                ✕
                              </span>
                            )}

                            {/* Tool Icon */}
                            <span className="text-[var(--text-tertiary)] shrink-0">
                              {getToolIcon(step.tool)}
                            </span>

                            {/* Tool Action & Result Summary */}
                            <div className="flex items-center gap-2 min-w-0 truncate">
                              <span className="font-mono text-[11px] text-[var(--text-primary)] truncate">
                                {step.status === "completed" && step.resultSummary
                                  ? step.resultSummary
                                  : step.title}
                              </span>
                            </div>
                          </div>

                          {/* Right duration & chevron */}
                          <div className="flex items-center gap-2 shrink-0">
                            {step.durationMs !== undefined && (
                              <span className="text-[10px] font-mono text-[var(--text-tertiary)]">
                                {formatDuration(step.durationMs)}
                              </span>
                            )}
                            {hasDetails && (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className={`text-[var(--text-tertiary)] transition-transform ${isStepOpen ? "rotate-180" : ""}`}
                              >
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                            )}
                          </div>
                        </div>

                        {/* Step Details Inspector (Arguments & Output Preview) */}
                        {isStepOpen && (
                          <div className="border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)]/70 p-3 space-y-2.5 text-xs font-mono">
                            {/* Tool Arguments */}
                            {step.args && Object.keys(step.args).length > 0 && (
                              <div>
                                <div className="text-[10px] uppercase text-[var(--text-tertiary)] font-semibold mb-1">
                                  Parameters
                                </div>
                                <pre className="p-2 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)] text-[11px] whitespace-pre-wrap break-all overflow-x-auto">
                                  {JSON.stringify(step.args, null, 2)}
                                </pre>
                              </div>
                            )}

                            {/* Tool Output Preview */}
                            {step.output && (
                              <div>
                                <div className="flex items-center justify-between text-[10px] uppercase text-[var(--text-tertiary)] font-semibold mb-1">
                                  <span>Output Result</span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleCopyStep(step.id, step.output!);
                                    }}
                                    className="px-1.5 py-0.5 rounded-[var(--radius-sm)] hover:bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors normal-case"
                                  >
                                    {copiedStepId === step.id ? "Copied" : "Copy"}
                                  </button>
                                </div>
                                <pre className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] text-[11px] leading-relaxed whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
                                  {step.output}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Waiting for confirmation banner */}
            {runState === "awaiting_confirmation" && (
              <div className="px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--status-warning)]/15 border border-[var(--status-warning)]/30 text-xs text-[var(--status-warning)] flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[var(--status-warning)] shrink-0 animate-pulse" />
                <span>Sensitive action confirmation required. Please review the prompt above to proceed.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
