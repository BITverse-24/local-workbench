import { useCallback, useEffect, useState } from "react";
import * as wb from "../lib/workbench";

type Props = {
  runEvents?: RunEvent[];
  runId?: string | null;
};

type TraceEntry = Record<string, unknown> & {
  phase?: string;
  taskType?: string;
  timestamp?: string;
  requestId?: string;
};

type ModalType = "transcript" | "trace" | "files" | null;

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
    case "grounding_context": return "📖";
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
    case "grounding_context": return e.status === "injected" ? `SOP Grounding: ${e.chunkCount ?? 0} chunk(s) injected` : e.status === "retrieving" ? "SOP Grounding: retrieving..." : "SOP Grounding: skipped";
    case "error": return `${e.code}: ${e.message}`;
    default: return "";
  }
}

function phaseColor(phase?: string): string {
  switch (phase) {
    case "request": return "text-sky-300";
    case "http_response": return "text-zinc-300";
    case "envelope": return "text-violet-300";
    case "provider_content_raw": return "text-amber-300";
    case "parsed_json": return "text-emerald-300";
    case "normalized": return "text-emerald-400";
    case "gateway_error": return "text-red-400";
    case "parse_error":
    case "normalize_error":
    case "envelope_parse_error":
    case "provider_error": return "text-red-300";
    default: return "text-zinc-400";
  }
}

function tracePreview(entry: TraceEntry): string {
  if (entry.phase === "request") {
    return `${String(entry.taskType ?? "?")} → ${String(entry["providerModel"] ?? entry.modelId ?? "?")} max_tokens=${String(entry["maxTokens"] ?? "")}`;
  }
  if (entry.phase === "http_response") {
    return `HTTP ${String(entry["status"] ?? "?")} in ${String(entry["latencyMs"] ?? "?")}ms`;
  }
  if (entry.phase === "provider_content_raw") {
    const c = entry["extractedContent"];
    const s = typeof c === "string" ? c : JSON.stringify(c ?? "");
    return s.slice(0, 160).replace(/\s+/g, " ");
  }
  if (entry.phase === "parsed_json") {
    return JSON.stringify(entry["parsedJson"]).slice(0, 160);
  }
  if (entry.phase === "normalized") {
    return `result keys=${entry["result"] && typeof entry["result"] === "object" ? Object.keys(entry["result"] as object).join(",") : "?"}`;
  }
  if (entry.phase === "gateway_error" || entry.phase === "parse_error") {
    return String(entry["error"] ?? "").slice(0, 160);
  }
  return JSON.stringify(entry).slice(0, 160);
}

export default function RunTelemetryWidget({ runEvents = [], runId }: Props) {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // Independent Modal State: null = closed, or one of the 3 diagnostics
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [expandedTraceIdx, setExpandedTraceIdx] = useState<number | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [selectedFileContent, setSelectedFileContent] = useState<unknown>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const fetchLogs = useCallback(async () => {
    if (!runId) return;
    if (!wb.isWorkbenchAvailable()) return;
    setLoading(true);
    try {
      const res = await wb.getRunLogs({ runId, limit: 100 });
      setEntries((res.entries as TraceEntry[]) ?? []);
      setFiles(res.files ?? []);
    } catch {
      // keep prior logs
    }
    setLoading(false);
  }, [runId]);

  useEffect(() => {
    void fetchLogs();
    if (!runId) {
      setEntries([]);
      setFiles([]);
      return;
    }
    const id = window.setInterval(() => {
      void fetchLogs();
    }, 2500);
    return () => window.clearInterval(id);
  }, [runId, fetchLogs]);

  const openFile = useCallback(async (filename: string) => {
    if (!runId) return;
    try {
      const res = await wb.getRunLogFile({ runId, filename });
      setSelectedFileContent(res.content);
      setSelectedFileName(filename);
    } catch (e) {
      setSelectedFileContent({ error: e instanceof Error ? e.message : String(e) });
      setSelectedFileName(filename);
    }
  }, [runId]);

  const handleOpenModal = (modal: ModalType) => {
    setActiveModal(modal);
    if (modal === "files" && files.length > 0 && !selectedFileName) {
      void openFile(files[files.length - 1]!);
    }
  };

  const handleCopy = (content: unknown) => {
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    void navigator.clipboard.writeText(text);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const latestEvent = runEvents.length > 0 ? runEvents[runEvents.length - 1] : null;
  const latestTrace = entries.length > 0 ? entries[entries.length - 1] : null;
  const latestFile = files.length > 0 ? files[files.length - 1] : null;
  const hasError = entries.some(
    (e) => e.phase === "gateway_error" || e.phase === "parse_error" || e.phase === "normalize_error"
  );

  return (
    <>
      <div className="space-y-3 p-4 rounded-2xl neu-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium opacity-60">Run Diagnostics</span>
            {loading && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />}
            {hasError && <span className="w-1.5 h-1.5 rounded-full bg-red-400" title="Error in logs" />}
          </div>
          {runId && (
            <span className="text-[10px] font-mono opacity-40">
              run:{runId.slice(0, 8)}
            </span>
          )}
        </div>

        {/* 1. Run Transcript Row (Latest Update Only) */}
        <div
          onClick={() => handleOpenModal("transcript")}
          className="p-2.5 rounded-xl bg-black/20 hover:bg-black/30 border border-white/5 cursor-pointer transition-colors group"
        >
          <div className="flex items-center justify-between text-[11px] font-medium opacity-70 mb-1">
            <div className="flex items-center gap-1.5">
              <span>Run Transcript</span>
              {runEvents.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-white/10 font-mono">
                  {runEvents.length}
                </span>
              )}
            </div>
            <span className="opacity-40 group-hover:opacity-100 text-xs transition-opacity" title="Pop open detail">
              ⤢
            </span>
          </div>
          {latestEvent ? (
            <div className="flex items-center gap-2 text-xs truncate">
              <span className="opacity-50 shrink-0 font-mono">{iconFor(latestEvent)}</span>
              <span className="opacity-80 truncate">{labelFor(latestEvent)}</span>
            </div>
          ) : (
            <div className="text-[11px] opacity-35 italic">No transcript events yet</div>
          )}
        </div>

        {/* 2. Model Trace Row (Latest Update Only) */}
        <div
          onClick={() => handleOpenModal("trace")}
          className="p-2.5 rounded-xl bg-black/20 hover:bg-black/30 border border-white/5 cursor-pointer transition-colors group"
        >
          <div className="flex items-center justify-between text-[11px] font-medium opacity-70 mb-1">
            <div className="flex items-center gap-1.5">
              <span>Model Trace</span>
              {entries.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-white/10 font-mono">
                  {entries.length}
                </span>
              )}
            </div>
            <span className="opacity-40 group-hover:opacity-100 text-xs transition-opacity" title="Pop open detail">
              ⤢
            </span>
          </div>
          {latestTrace ? (
            <div className="flex items-center gap-2 text-xs truncate">
              <span className={`text-[10px] font-mono shrink-0 ${phaseColor(latestTrace.phase)}`}>
                [{latestTrace.phase ?? "?"}]
              </span>
              <span className="opacity-80 truncate">{tracePreview(latestTrace)}</span>
            </div>
          ) : (
            <div className="text-[11px] opacity-35 italic">No model trace entries yet</div>
          )}
        </div>

        {/* 3. Per-Request Files Row (Latest Update Only) */}
        <div
          onClick={() => handleOpenModal("files")}
          className="p-2.5 rounded-xl bg-black/20 hover:bg-black/30 border border-white/5 cursor-pointer transition-colors group"
        >
          <div className="flex items-center justify-between text-[11px] font-medium opacity-70 mb-1">
            <div className="flex items-center gap-1.5">
              <span>Per-Request Files</span>
              {files.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-white/10 font-mono">
                  {files.length}
                </span>
              )}
            </div>
            <span className="opacity-40 group-hover:opacity-100 text-xs transition-opacity" title="Pop open detail">
              ⤢
            </span>
          </div>
          {latestFile ? (
            <div className="flex items-center gap-2 text-xs truncate font-mono">
              <span className="opacity-40 shrink-0">📄</span>
              <span className="opacity-80 truncate">{latestFile}</span>
            </div>
          ) : (
            <div className="text-[11px] opacity-35 italic">No per-request files yet</div>
          )}
        </div>
      </div>

      {/* Independent Modal Dialog: Run Transcript */}
      {activeModal === "transcript" && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-apple-fade"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="bg-[#1c1c1c] border border-white/10 rounded-2xl w-full max-w-3xl h-[80vh] flex flex-col overflow-hidden shadow-2xl animate-apple-scaleIn"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-white/10 bg-black/30">
              <div className="flex items-center gap-2.5">
                <span className="text-base font-semibold">Run Transcript</span>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-white/10 font-mono text-white/80">
                  {runEvents.length} {runEvents.length === 1 ? "event" : "events"}
                </span>
                {runId && <span className="text-[11px] font-mono opacity-40 ml-2">run:{runId.slice(0, 8)}</span>}
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/15 grid place-items-center text-sm transition-colors"
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-hidden p-4">
              {runEvents.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs opacity-40 italic">
                  No run events recorded yet.
                </div>
              ) : (
                <div className="h-full overflow-y-auto space-y-1.5 pr-2">
                  {runEvents.map((e, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-3 p-2.5 rounded-xl bg-black/25 border border-white/5 text-xs font-mono"
                    >
                      <span className="opacity-40 shrink-0 w-5 text-center mt-0.5">{iconFor(e)}</span>
                      <div className="flex-1 break-words">
                        <span className="opacity-40 mr-2">[{e.type}]</span>
                        <span className="opacity-90">{labelFor(e)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Independent Modal Dialog: Model Trace */}
      {activeModal === "trace" && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-apple-fade"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="bg-[#1c1c1c] border border-white/10 rounded-2xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden shadow-2xl animate-apple-scaleIn"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-white/10 bg-black/30">
              <div className="flex items-center gap-2.5">
                <span className="text-base font-semibold">Model Trace</span>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-white/10 font-mono text-white/80">
                  {entries.length} {entries.length === 1 ? "entry" : "entries"}
                </span>
                {hasError && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 font-medium">
                    errors detected
                  </span>
                )}
                {runId && <span className="text-[11px] font-mono opacity-40 ml-2">run:{runId.slice(0, 8)}</span>}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => void fetchLogs()}
                  className="px-3 py-1 rounded-full neu-button text-xs font-medium"
                >
                  Refresh
                </button>
                <button
                  onClick={() => setActiveModal(null)}
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/15 grid place-items-center text-sm transition-colors ml-1"
                  title="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-hidden p-4">
              {entries.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs opacity-40 italic">
                  No model trace entries logged yet for this run.
                </div>
              ) : (
                <div className="h-full overflow-y-auto space-y-2 pr-2">
                  {entries.map((entry, idx) => (
                    <div
                      key={idx}
                      className={`rounded-xl p-3 bg-black/25 border border-white/5 transition-colors ${
                        expandedTraceIdx === idx ? "bg-black/45 border-white/15" : ""
                      }`}
                    >
                      <button
                        onClick={() => setExpandedTraceIdx(expandedTraceIdx === idx ? null : idx)}
                        className="w-full text-left flex gap-2.5 items-start"
                      >
                        <span className={`text-[11px] font-mono shrink-0 mt-0.5 ${phaseColor(entry.phase)}`}>
                          [{entry.phase ?? "?"}]
                        </span>
                        <span className="text-xs opacity-80 break-all leading-relaxed flex-1 font-mono">
                          {tracePreview(entry)}
                        </span>
                        <span className="text-[10px] opacity-30 shrink-0">
                          {entry.timestamp ? new Date(entry.timestamp as string).toLocaleTimeString() : ""}
                        </span>
                      </button>
                      {expandedTraceIdx === idx && (
                        <div className="mt-2.5 pt-2 border-t border-white/10 flex flex-col gap-2">
                          <div className="flex justify-end">
                            <button
                              onClick={() => handleCopy(entry)}
                              className="px-2.5 py-1 rounded-full neu-button text-[11px]"
                            >
                              {copyFeedback ? "Copied!" : "Copy Payload"}
                            </button>
                          </div>
                          <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all bg-black/50 rounded-lg p-3 max-h-[300px] overflow-auto">
                            {JSON.stringify(entry, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Independent Modal Dialog: Per-Request Files */}
      {activeModal === "files" && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-apple-fade"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="bg-[#1c1c1c] border border-white/10 rounded-2xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden shadow-2xl animate-apple-scaleIn"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-white/10 bg-black/30">
              <div className="flex items-center gap-2.5">
                <span className="text-base font-semibold">Per-Request Files</span>
                <span className="text-xs px-2.5 py-0.5 rounded-full bg-white/10 font-mono text-white/80">
                  {files.length} {files.length === 1 ? "file" : "files"}
                </span>
                {runId && <span className="text-[11px] font-mono opacity-40 ml-2">run:{runId.slice(0, 8)}</span>}
              </div>

              <div className="flex items-center gap-2">
                {selectedFileContent != null && (
                  <button
                    onClick={() => handleCopy(selectedFileContent)}
                    className="px-3 py-1 rounded-full neu-button text-xs font-medium"
                  >
                    {copyFeedback ? "Copied!" : "Copy JSON"}
                  </button>
                )}
                <button
                  onClick={() => setActiveModal(null)}
                  className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/15 grid place-items-center text-sm transition-colors ml-1"
                  title="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-hidden p-4">
              {files.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs opacity-40 italic">
                  No per-request trace files generated yet for this run.
                </div>
              ) : (
                <div className="h-full flex flex-col gap-3">
                  <div className="flex flex-wrap gap-1.5 max-h-[90px] overflow-y-auto p-1 bg-black/20 rounded-xl border border-white/5">
                    {files.map((f) => (
                      <button
                        key={f}
                        onClick={() => void openFile(f)}
                        className={`px-3 py-1 rounded-full text-xs font-mono transition-colors ${
                          selectedFileName === f
                            ? "bg-white/20 text-white font-semibold shadow-sm"
                            : "bg-white/5 hover:bg-white/10 opacity-70"
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>

                  <div className="flex-1 bg-black/40 rounded-xl border border-white/10 overflow-hidden flex flex-col">
                    <div className="p-2.5 px-4 bg-black/30 border-b border-white/10 text-xs font-mono opacity-60 flex justify-between">
                      <span>{selectedFileName ?? "Select a file to inspect"}</span>
                    </div>
                    <pre className="p-4 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all overflow-auto flex-1 text-emerald-300/90">
                      {selectedFileContent != null
                        ? typeof selectedFileContent === "string"
                          ? selectedFileContent
                          : JSON.stringify(selectedFileContent, null, 2)
                        : "Click any file button above to inspect its untruncated content."}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
