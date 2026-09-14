import { useCallback, useEffect, useState } from "react";
import * as wb from "../lib/workbench";

type Props = { runId: string | null };

type TraceEntry = Record<string, unknown> & { phase?: string; taskType?: string; timestamp?: string; requestId?: string };

function phaseColor(phase?: string) {
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

function preview(entry: TraceEntry): string {
  if (entry.phase === "request") return `${String(entry.taskType ?? "?")} → ${String(entry["providerModel"] ?? entry.modelId ?? "?")} max_tokens=${String(entry["maxTokens"] ?? "")}`;
  if (entry.phase === "http_response") return `HTTP ${String(entry["status"] ?? "?")} ${String(entry["rawTextChars"] ?? "")} chars in ${String(entry["latencyMs"] ?? "?")}ms`;
  if (entry.phase === "provider_content_raw") {
    const c = entry["extractedContent"];
    const s = typeof c === "string" ? c : JSON.stringify(c ?? "");
    return s.slice(0, 220).replace(/\s+/g, " ");
  }
  if (entry.phase === "parsed_json") return JSON.stringify(entry["parsedJson"]).slice(0, 220);
  if (entry.phase === "normalized") return `result keys=${entry["result"] && typeof entry["result"] === "object" ? Object.keys(entry["result"] as object).join(",") : "?"}`;
  if (entry.phase === "gateway_error" || entry.phase === "parse_error") return String(entry["error"] ?? "").slice(0, 220);
  return JSON.stringify(entry).slice(0, 220);
}

export default function ModelTracePanel({ runId }: Props) {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [recentFull, setRecentFull] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [fullOpen, setFullOpen] = useState(false);
  const [selectedFileContent, setSelectedFileContent] = useState<unknown>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    if (!runId) return;
    if (!wb.isWorkbenchAvailable()) return;
    setLoading(true);
    try {
      const res = await wb.getRunLogs({ runId, limit: 80 });
      setEntries((res.entries as TraceEntry[]) ?? []);
      setFiles(res.files ?? []);
      setRecentFull(res.recentFull ?? null);
    } catch {
      // keep previous
    }
    setLoading(false);
  }, [runId]);

  useEffect(() => {
    void fetchLogs();
    if (!runId) {
      setEntries([]);
      setFiles([]);
      setRecentFull(null);
      return;
    }
    const id = window.setInterval(() => { void fetchLogs(); }, 2500);
    return () => window.clearInterval(id);
  }, [runId, fetchLogs]);

  const openFile = useCallback(async (filename: string) => {
    if (!runId) return;
    try {
      const res = await wb.getRunLogFile({ runId, filename });
      setSelectedFileContent(res.content);
      setSelectedFileName(filename);
      setFullOpen(true);
    } catch (e) {
      setSelectedFileContent({ error: e instanceof Error ? e.message : String(e) });
      setSelectedFileName(filename);
      setFullOpen(true);
    }
  }, [runId]);

  if (!runId) return null;

  const hasFailedEntry = entries.some((e) => e.phase === "gateway_error" || e.phase === "parse_error" || e.phase === "normalize_error");

  return (
    <div className="mx-4 my-2 rounded-[var(--radius-md)] neu-card border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-[var(--text-secondary)] flex items-center gap-2">
          Model trace {loading && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] inline-block" />}
          {hasFailedEntry && <span className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--status-error)]/15 text-[var(--status-error)] border border-[var(--status-error)]/30 text-[10px] font-medium">has error</span>}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => void fetchLogs()} className="px-2 py-0.5 rounded-[var(--radius-sm)] neu-button text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Refresh</button>
          {recentFull != null && (
            <button onClick={() => { setSelectedFileContent(recentFull); setSelectedFileName("recentFull (latest)"); setFullOpen(true); }} className="px-2 py-0.5 rounded-[var(--radius-sm)] neu-button text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Full JSON</button>
          )}
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="text-xs text-[var(--text-tertiary)]">No model logs yet for this run. Logs appear after each gateway call — check <span className="font-mono">backend/data/runs/{(runId ?? "").slice(0, 8)}…/logs/</span>.</div>
      ) : (
        <div className="space-y-1 max-h-[220px] overflow-y-auto pr-1">
          {entries.map((e, i) => (
            <div key={i} className={`rounded-[var(--radius-sm)] px-2 py-1.5 bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] ${expanded === i ? "bg-[var(--bg-surface-raised)]" : ""}`}>
              <button onClick={() => setExpanded(expanded === i ? null : i)} className="w-full text-left flex gap-2 items-start">
                <span className={`text-[10px] font-mono shrink-0 mt-0.5 ${phaseColor(e.phase)}`}>{e.phase ?? "?"}</span>
                <span className="text-xs text-[var(--text-secondary)] break-all leading-relaxed flex-1">{preview(e)}</span>
                <span className="text-[10px] text-[var(--text-tertiary)] shrink-0 font-mono">{e.timestamp ? new Date(e.timestamp as string).toLocaleTimeString() : ""}</span>
              </button>
              {expanded === i && (
                <pre className="mt-2 text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-all bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[var(--text-primary)] rounded-[var(--radius-sm)] p-2 max-h-[300px] overflow-auto">
                  {JSON.stringify(e, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
          <div className="text-[11px] text-[var(--text-tertiary)] mb-1">Per-request files — full untruncated traces:</div>
          <div className="flex flex-wrap gap-1">
            {files.map((f) => (
              <button key={f} onClick={() => void openFile(f)} className="px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] hover:bg-[var(--bg-surface)] text-[11px] font-mono text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                {f}
              </button>
            ))}
          </div>
        </div>
      )}

      {fullOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setFullOpen(false)}>
          <div className="bg-[var(--bg-surface)] border border-[var(--border-subtle)] rounded-[var(--radius-md)] w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-[var(--border-subtle)] bg-[var(--bg-surface-raised)]">
              <span className="text-xs font-mono text-[var(--text-secondary)] truncate">{selectedFileName}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const text = JSON.stringify(selectedFileContent, null, 2);
                    void navigator.clipboard.writeText(text);
                  }}
                  className="px-2.5 py-1 rounded-[var(--radius-sm)] neu-button text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Copy
                </button>
                <button onClick={() => setFullOpen(false)} className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
              </div>
            </div>
            <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all overflow-auto flex-1 bg-[var(--bg-canvas)] text-[var(--text-primary)]">{JSON.stringify(selectedFileContent, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
