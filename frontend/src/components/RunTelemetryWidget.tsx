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
    case "gateway_error":
    case "parse_error":
    case "normalize_error":
    case "envelope_parse_error":
    case "provider_error":
      return "text-[var(--status-error)]";
    case "normalized":
    case "parsed_json":
      return "text-[var(--status-success)]";
    default:
      return "text-[var(--text-secondary)]";
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
      <div className="space-y-3 p-3.5 rounded-[var(--radius-md)] neu-card border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--text-secondary)]">Run diagnostics</span>
            {loading && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />}
            {hasError && <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-error)]" title="Error in logs" />}
          </div>
          {runId && (
            <span className="text-[10px] font-mono text-[var(--text-tertiary)]">
              run:{runId.slice(0, 8)}
            </span>
          )}
        </div>

        {/* 1. Run Transcript Row (Latest Update Only) */}
        <div
          onClick={() => handleOpenModal("transcript")}
          className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] hover:bg-[var(--bg-surface)] border border-[var(--border-subtle)] cursor-pointer transition-colors group"
        >
          <div className="flex items-center justify-between text-[11px] font-medium text-[var(--text-secondary)] mb-1">
            <div className="flex items-center gap-1.5">
              <span>Run transcript</span>
              {runEvents.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-[var(--text-tertiary)] font-mono border border-[var(--border-subtle)]">
                  {runEvents.length}
                </span>
              )}
            </div>
            <span className="text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)] text-xs transition-colors" title="Expand detail">
              ⤢
            </span>
          </div>
          {latestEvent ? (
            <div className="flex items-center gap-2 text-xs truncate">
              <span className="text-[var(--text-tertiary)] shrink-0 font-mono">{iconFor(latestEvent)}</span>
              <span className="text-[var(--text-primary)] truncate">{labelFor(latestEvent)}</span>
            </div>
          ) : (
            <div className="text-[11px] text-[var(--text-tertiary)] italic">No transcript events yet</div>
          )}
        </div>

        {/* 2. Model Trace Row (Latest Update Only) */}
        <div
          onClick={() => handleOpenModal("trace")}
          className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] hover:bg-[var(--bg-surface)] border border-[var(--border-subtle)] cursor-pointer transition-colors group"
        >
          <div className="flex items-center justify-between text-[11px] font-medium text-[var(--text-secondary)] mb-1">
            <div className="flex items-center gap-1.5">
              <span>Model trace</span>
              {entries.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-[var(--text-tertiary)] font-mono border border-[var(--border-subtle)]">
                  {entries.length}
                </span>
              )}
            </div>
            <span className="text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)] text-xs transition-colors" title="Expand detail">
              ⤢
            </span>
          </div>
          {latestTrace ? (
            <div className="flex items-center gap-2 text-xs truncate">
              <span className={`text-[10px] font-mono shrink-0 ${phaseColor(latestTrace.phase)}`}>
                [{latestTrace.phase ?? "?"}]
              </span>
              <span className="text-[var(--text-primary)] truncate font-mono text-[11px]">{tracePreview(latestTrace)}</span>
            </div>
          ) : (
            <div className="text-[11px] text-[var(--text-tertiary)] italic">No model trace entries yet</div>
          )}
        </div>

        {/* 3. Per-Request Files Row (Latest Update Only) */}
        <div
          onClick={() => handleOpenModal("files")}
          className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] hover:bg-[var(--bg-surface)] border border-[var(--border-subtle)] cursor-pointer transition-colors group"
        >
          <div className="flex items-center justify-between text-[11px] font-medium text-[var(--text-secondary)] mb-1">
            <div className="flex items-center gap-1.5">
              <span>Per-request files</span>
              {files.length > 0 && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-[var(--text-tertiary)] font-mono border border-[var(--border-subtle)]">
                  {files.length}
                </span>
              )}
            </div>
            <span className="text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)] text-xs transition-colors" title="Expand detail">
              ⤢
            </span>
          </div>
          {latestFile ? (
            <div className="flex items-center gap-2 text-xs truncate font-mono">
              <span className="text-[var(--text-tertiary)] shrink-0">📄</span>
              <span className="text-[var(--text-primary)] truncate">{latestFile}</span>
            </div>
          ) : (
            <div className="text-[11px] text-[var(--text-tertiary)] italic">No per-request files yet</div>
          )}
        </div>
      </div>

      {/* Independent Modal Dialog: Run Transcript */}
      {activeModal === "transcript" && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] w-full max-w-3xl h-[80vh] flex flex-col overflow-hidden"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-raised)]">
              <div className="flex items-center gap-2.5">
                <span className="text-sm font-medium text-[var(--text-primary)]">Run transcript</span>
                <span className="text-xs px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono text-[var(--text-secondary)]">
                  {runEvents.length} {runEvents.length === 1 ? "event" : "events"}
                </span>
                {runId && <span className="text-[11px] font-mono text-[var(--text-tertiary)] ml-2">run:{runId.slice(0, 8)}</span>}
              </div>
              <button
                onClick={() => setActiveModal(null)}
                className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="flex-1 overflow-hidden p-4">
              {runEvents.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--text-tertiary)] italic">
                  No run events recorded yet.
                </div>
              ) : (
                <div className="h-full overflow-y-auto space-y-1.5 pr-2">
                  {runEvents.map((e, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-3 p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-xs font-mono"
                    >
                      <span className="text-[var(--text-tertiary)] shrink-0 w-5 text-center mt-0.5">{iconFor(e)}</span>
                      <div className="flex-1 break-words">
                        <span className="text-[var(--text-tertiary)] mr-2">[{e.type}]</span>
                        <span className="text-[var(--text-primary)]">{labelFor(e)}</span>
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
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-raised)]">
              <div className="flex items-center gap-2.5">
                <span className="text-sm font-medium text-[var(--text-primary)]">Model trace</span>
                <span className="text-xs px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono text-[var(--text-secondary)]">
                  {entries.length} {entries.length === 1 ? "entry" : "entries"}
                </span>
                {hasError && (
                  <span className="text-[10px] px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--status-error)]/15 text-[var(--status-error)] border border-[var(--status-error)]/30 font-medium">
                    errors detected
                  </span>
                )}
                {runId && <span className="text-[11px] font-mono text-[var(--text-tertiary)] ml-2">run:{runId.slice(0, 8)}</span>}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => void fetchLogs()}
                  className="px-2.5 py-1 rounded-[var(--radius-sm)] neu-button text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-medium"
                >
                  Refresh
                </button>
                <button
                  onClick={() => setActiveModal(null)}
                  className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors ml-1"
                  title="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-hidden p-4">
              {entries.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--text-tertiary)] italic">
                  No model trace entries logged yet for this run.
                </div>
              ) : (
                <div className="h-full overflow-y-auto space-y-2 pr-2">
                  {entries.map((entry, idx) => (
                    <div
                      key={idx}
                      className={`rounded-[var(--radius-sm)] p-3 bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] transition-colors ${
                        expandedTraceIdx === idx ? "bg-[var(--bg-surface-raised)] border-[var(--border-muted)]" : ""
                      }`}
                    >
                      <button
                        onClick={() => setExpandedTraceIdx(expandedTraceIdx === idx ? null : idx)}
                        className="w-full text-left flex gap-2.5 items-start"
                      >
                        <span className={`text-[11px] font-mono shrink-0 mt-0.5 ${phaseColor(entry.phase)}`}>
                          [{entry.phase ?? "?"}]
                        </span>
                        <span className="text-xs text-[var(--text-secondary)] break-all leading-relaxed flex-1 font-mono">
                          {tracePreview(entry)}
                        </span>
                        <span className="text-[10px] text-[var(--text-tertiary)] shrink-0 font-mono">
                          {entry.timestamp ? new Date(entry.timestamp as string).toLocaleTimeString() : ""}
                        </span>
                      </button>
                      {expandedTraceIdx === idx && (
                        <div className="mt-2.5 pt-2 border-t border-[var(--border-subtle)] flex flex-col gap-2">
                          <div className="flex justify-end">
                            <button
                              onClick={() => handleCopy(entry)}
                              className="px-2.5 py-1 rounded-[var(--radius-sm)] neu-button text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            >
                              {copyFeedback ? "Copied" : "Copy payload"}
                            </button>
                          </div>
                          <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all bg-[var(--bg-canvas)] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] text-[var(--text-primary)] p-3 max-h-[300px] overflow-auto">
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
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-raised)]">
              <div className="flex items-center gap-2.5">
                <span className="text-sm font-medium text-[var(--text-primary)]">Per-request files</span>
                <span className="text-xs px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono text-[var(--text-secondary)]">
                  {files.length} {files.length === 1 ? "file" : "files"}
                </span>
                {runId && <span className="text-[11px] font-mono text-[var(--text-tertiary)] ml-2">run:{runId.slice(0, 8)}</span>}
              </div>

              <div className="flex items-center gap-2">
                {selectedFileContent != null && (
                  <button
                    onClick={() => handleCopy(selectedFileContent)}
                    className="px-2.5 py-1 rounded-[var(--radius-sm)] neu-button text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-medium"
                  >
                    {copyFeedback ? "Copied" : "Copy JSON"}
                  </button>
                )}
                <button
                  onClick={() => setActiveModal(null)}
                  className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors ml-1"
                  title="Close"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-hidden p-4">
              {files.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--text-tertiary)] italic">
                  No per-request trace files generated yet for this run.
                </div>
              ) : (
                <div className="h-full flex flex-col gap-3">
                  <div className="flex flex-wrap gap-1.5 max-h-[90px] overflow-y-auto p-1.5 bg-[var(--bg-canvas)] rounded-[var(--radius-sm)] border border-[var(--border-subtle)]">
                    {files.map((f) => (
                      <button
                        key={f}
                        onClick={() => void openFile(f)}
                        className={`px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-mono border transition-colors ${
                          selectedFileName === f
                            ? "bg-[var(--accent-muted)] text-[var(--accent)] border-[var(--accent)]/40 font-medium"
                            : "bg-[var(--bg-surface-raised)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>

                  <div className="flex-1 bg-[var(--bg-canvas)] rounded-[var(--radius-sm)] border border-[var(--border-subtle)] overflow-hidden flex flex-col">
                    <div className="p-2.5 px-4 bg-[var(--bg-surface-raised)] border-b border-[var(--border-subtle)] text-xs font-mono text-[var(--text-secondary)] flex justify-between">
                      <span>{selectedFileName ?? "Select a file to inspect"}</span>
                    </div>
                    <pre className="p-4 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all overflow-auto flex-1 text-[var(--text-primary)]">
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
