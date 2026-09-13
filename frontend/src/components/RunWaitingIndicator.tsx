import { useState, useEffect, useMemo } from "react";

type Props = {
  isRunning: boolean;
  runState: RunState | null;
  activeRoute?: { taskType: string; modelId: string; reason: string } | null;
  runEvents?: RunEvent[];
};

export default function RunWaitingIndicator({
  isRunning,
  runState,
  activeRoute,
  runEvents = [],
}: Props) {
  const [elapsedMs, setElapsedMs] = useState(0);

  // Live timer while running
  useEffect(() => {
    if (!isRunning) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 100);
    return () => clearInterval(timer);
  }, [isRunning]);

  // Extract steps, tools, and grounding from runEvents
  const planSteps = useMemo(() => {
    const steps: Array<{ index: number; text: string }> = [];
    for (const e of runEvents) {
      if (e.type === "plan_step") {
        steps.push({ index: e.index, text: e.text });
      }
    }
    return steps.sort((a, b) => a.index - b.index);
  }, [runEvents]);

  const activeTool = useMemo(() => {
    let latestCall: { tool: string; summary: string } | null = null;
    let latestResultTool: string | null = null;
    for (const e of runEvents) {
      if (e.type === "tool_call") latestCall = { tool: e.tool, summary: e.summary };
      if (e.type === "tool_result") latestResultTool = e.tool;
    }
    // If latest call matches result, tool has finished
    const isBusy = latestCall && latestCall.tool !== latestResultTool;
    return {
      call: latestCall,
      isBusy: Boolean(isBusy),
    };
  }, [runEvents]);

  const groundingInfo = useMemo(() => {
    for (let i = runEvents.length - 1; i >= 0; i--) {
      const e = runEvents[i];
      if (e.type === "grounding_context") return e;
    }
    return null;
  }, [runEvents]);

  if (!isRunning) return null;

  const seconds = (elapsedMs / 1000).toFixed(1);
  const taskType = activeRoute?.taskType ?? "draft";
  const modelId = activeRoute?.modelId ?? "draft-qwen3";
  const reason = activeRoute?.reason ?? "processing request";

  const getRoleIcon = (type: string) => {
    switch (type.toLowerCase()) {
      case "vision":
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          </svg>
        );
      case "code":
      case "coding":
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        );
      case "draft":
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        );
      case "plan":
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
          </svg>
        );
      default:
        return (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8" />
          </svg>
        );
    }
  };

  // Human-readable status headline
  const headline = (() => {
    if (runState === "awaiting_confirmation") {
      return "Awaiting your approval for consequential action...";
    }
    if (activeTool.call && activeTool.isBusy) {
      const t = activeTool.call.tool;
      if (t === "read_file" || t === "ocr_extract") return `Extracting document evidence: ${activeTool.call.summary}`;
      if (t === "inspect_drawing") return `Inspecting drawing elements: ${activeTool.call.summary}`;
      if (t === "retrieve_sop") return `Grounding against local specifications: ${activeTool.call.summary}`;
      if (t === "draft_code") return `Generating verified Python code...`;
      if (t === "execute_python") return `Executing in sandbox: ${activeTool.call.summary}`;
      if (t === "draft_note") return `Formulating grounded engineering deliverable...`;
      return `${t}: ${activeTool.call.summary}`;
    }
    if (runState === "planning") return "Developing execution plan...";
    if (runState === "classifying") return "Analyzing task intent & staged attachments...";
    if (runState === "acting") return "Executing multi-step agent workflow...";
    return "Agent is processing...";
  })();

  return (
    <div className="flex justify-start w-full my-3">
      <div className="w-full max-w-[88%] md:max-w-[76%] rounded-[var(--radius-md)] p-4 md:p-5 border border-[var(--border-subtle)] bg-[var(--bg-surface-raised)] transition-all">
        {/* Top Header: Model Identity, Live Status & Timer */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-2 h-2 rounded-full bg-[var(--accent)] shrink-0" />

            <div className="flex items-center gap-2.5 truncate">
              <span className="text-sm font-mono text-[var(--text-primary)] font-medium truncate">{modelId}</span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--accent)] shrink-0">
                <span className="shrink-0">{getRoleIcon(taskType)}</span>
                <span>{taskType}</span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 font-mono text-xs text-[var(--text-tertiary)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-success)]" />
            <span>{seconds}s</span>
          </div>
        </div>

        {/* Live Status Headline with Spinner */}
        <div className="mt-3.5 flex items-start gap-2.5 text-sm text-[var(--text-primary)]">
          <span className="mt-0.5 w-4 h-4 border border-[var(--border-default)] border-t-[var(--accent)] rounded-full animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium leading-tight text-[var(--text-primary)] truncate text-sm">{headline}</div>
            <div className="text-xs text-[var(--text-tertiary)] mt-1 truncate">Route: {reason}</div>
          </div>
        </div>

        {/* SOP Grounding Context Pill (if active) */}
        {groundingInfo && (
          <div className="mt-2.5 inline-flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] font-medium">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span>
              {groundingInfo.status === "retrieving"
                ? "Querying local Knowledge Base (SOP criteria)..."
                : groundingInfo.status === "injected"
                ? `Grounded in ${groundingInfo.chunkCount ?? 0} retrieved SOP specification clauses`
                : "No matching SOP clauses retrieved"}
            </span>
          </div>
        )}

        {/* Streamed Plan Steps (if multiple available) */}
        {planSteps.length > 1 && (
          <div className="mt-4 pt-3.5 border-t border-[var(--border-subtle)] space-y-2">
            <div className="text-xs tracking-[0.02em] font-medium text-[var(--text-tertiary)] mb-1.5">
              Execution plan
            </div>
            {planSteps.map((step, idx) => {
              const isPast = activeTool.call ? idx < 2 : idx === 0;
              const isCurrent = activeTool.call ? idx === 2 : idx === 1;

              return (
                <div key={idx} className="flex items-center gap-2.5 text-sm">
                  {isPast ? (
                    <span className="w-4.5 h-4.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--status-success)] grid place-items-center text-xs shrink-0 font-bold">
                      ✓
                    </span>
                  ) : isCurrent ? (
                    <span className="w-4.5 h-4.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--accent)] text-[var(--accent)] grid place-items-center text-xs shrink-0">
                      ⟳
                    </span>
                  ) : (
                    <span className="w-4.5 h-4.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] grid place-items-center text-xs shrink-0">
                      ○
                    </span>
                  )}
                  <span
                    className={`leading-normal ${
                      isPast
                        ? "text-[var(--text-secondary)]"
                        : isCurrent
                        ? "text-[var(--text-primary)] font-medium"
                        : "text-[var(--text-tertiary)]"
                    }`}
                  >
                    {step.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Restrained 1px progress line and static low-opacity skeleton bar */}
        <div className="mt-4 pt-3 border-t border-[var(--border-subtle)] space-y-2">
          <div className="h-[1px] w-full bg-[var(--border-subtle)] overflow-hidden">
            <div className="h-[1px] w-1/3 bg-[var(--accent)]" />
          </div>
          <div className="h-2 w-[85%] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] opacity-60" />
          <div className="h-2 w-[60%] rounded-[var(--radius-sm)] bg-[var(--bg-surface)] opacity-40" />
        </div>
      </div>
    </div>
  );
}
