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

  const modelColor =
    taskType === "code"
      ? {
          border: "border-sky-500/30",
          glow: "bg-sky-500/10 text-sky-400",
          accent: "bg-sky-400",
          badge: "bg-sky-500/15 text-sky-300 border-sky-500/30",
        }
      : taskType === "vision"
      ? {
          border: "border-violet-500/30",
          glow: "bg-violet-500/10 text-violet-400",
          accent: "bg-violet-400",
          badge: "bg-violet-500/15 text-violet-300 border-violet-500/30",
        }
      : {
          border: "border-emerald-500/30",
          glow: "bg-emerald-500/10 text-emerald-400",
          accent: "bg-emerald-400",
          badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
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
    <div className="flex justify-start w-full my-3 animate-apple-message">
      <div
        className={`w-full max-w-[88%] md:max-w-[76%] rounded-2xl neu-panel p-4 md:p-5 border ${modelColor.border} bg-[#1C1C1C] shadow-lg transition-all duration-300`}
        style={{
          boxShadow: "0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04)",
        }}
      >
        {/* Top Header: Model Identity, Live Status & Timer */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/[0.08]">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Animated Pulsing Beacon */}
            <div className="relative flex items-center justify-center w-5 h-5 shrink-0">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${modelColor.accent}`} />
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${modelColor.accent}`} />
            </div>

            <div className="flex items-center gap-2 truncate">
              <span className="text-xs font-semibold text-white/90 truncate">{modelId}</span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium tracking-wider uppercase border ${modelColor.badge} shrink-0`}>
                {taskType}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 font-mono text-[11px] text-white/50">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>{seconds}s</span>
          </div>
        </div>

        {/* Live Status Headline with Spinner */}
        <div className="mt-3.5 flex items-start gap-2.5 text-xs text-white/90">
          <span className="mt-0.5 w-3.5 h-3.5 border-2 border-white/20 border-t-white/80 rounded-full animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium leading-tight text-white/90 truncate">{headline}</div>
            <div className="text-[11px] text-white/40 mt-0.5 truncate">Route: {reason}</div>
          </div>
        </div>

        {/* SOP Grounding Context Pill (if active) */}
        {groundingInfo && (
          <div className="mt-2.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/[0.08] border border-emerald-500/20 text-[11px] text-emerald-400/90 font-medium">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
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

        {/* Streamed Plan Steps (if available) */}
        {planSteps.length > 0 && (
          <div className="mt-3.5 pt-3 border-t border-white/[0.06] space-y-1.5">
            <div className="text-[10px] uppercase font-semibold tracking-wider text-white/40 mb-1">
              Execution Plan
            </div>
            {planSteps.map((step, idx) => {
              const isPast = activeTool.call ? idx < 2 : idx === 0;
              const isCurrent = activeTool.call ? idx === 2 : idx === 1;

              return (
                <div key={idx} className="flex items-center gap-2 text-xs">
                  {isPast ? (
                    <span className="w-4 h-4 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 grid place-items-center text-[10px] shrink-0 font-bold">
                      ✓
                    </span>
                  ) : isCurrent ? (
                    <span className="w-4 h-4 rounded-full bg-sky-500/20 border border-sky-500/40 text-sky-300 grid place-items-center text-[10px] shrink-0 animate-pulse">
                      ⟳
                    </span>
                  ) : (
                    <span className="w-4 h-4 rounded-full bg-white/[0.04] border border-white/10 text-white/30 grid place-items-center text-[10px] shrink-0">
                      ○
                    </span>
                  )}
                  <span
                    className={`leading-tight ${
                      isPast
                        ? "text-white/60 line-through decoration-white/20"
                        : isCurrent
                        ? "text-white/90 font-medium"
                        : "text-white/40"
                    }`}
                  >
                    {step.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Shimmering Skeleton Lines (simulating live response generation) */}
        <div className="mt-4 pt-3 border-t border-white/[0.06] space-y-2.5">
          <div className="h-3 w-[92%] rounded-full bg-gradient-to-r from-white/[0.04] via-white/[0.09] to-white/[0.04] animate-pulse" />
          <div className="h-3 w-[76%] rounded-full bg-gradient-to-r from-white/[0.04] via-white/[0.09] to-white/[0.04] animate-pulse delay-100" />
          <div className="h-3 w-[84%] rounded-full bg-gradient-to-r from-white/[0.04] via-white/[0.09] to-white/[0.04] animate-pulse delay-200" />
          <div className="h-3 w-[52%] rounded-full bg-gradient-to-r from-white/[0.04] via-white/[0.09] to-white/[0.04] animate-pulse delay-300" />
        </div>
      </div>
    </div>
  );
}
