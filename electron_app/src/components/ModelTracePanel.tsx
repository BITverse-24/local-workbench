import { useCallback, useEffect, useState } from "react";
import * as wb from "../lib/workbench";

type Props = { runId: string | null };

type TraceEntry = Record<string, unknown> & { phase?: string; taskType?: string; timestamp?: string; requestId?: string };

function phaseColor(phase?: string) {
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
    <div className="mx-4 my-2 rounded-xl neu-card p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] tracking-[0.12em] uppercase opacity-50 flex items-center gap-2">
          Model trace {loading && <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse inline-block" />}
          {hasFailedEntry && <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 normal-case tracking-normal text-[10px]">has error</span>}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => void fetchLogs()} className="px-2 py-1 rounded-full neu-button text-[11px]">Refresh</button>
          {recentFull != null && (
            <button onClick={() => { setSelectedFileContent(recentFull); setSelectedFileName("recentFull (latest)"); setFullOpen(true); }} className="px-2 py-1 rounded-full neu-button text-[11px]">Full JSON</button>
          )}
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="text-xs opacity-40">No model logs yet for this run. Logs appear after each gateway call — check <span className="font-mono">backend/data/runs/{(runId ?? "").slice(0, 8)}…/logs/</span>.</div>
      ) : (
        <div className="space-y-1 max-h-[220px] overflow-y-auto pr-1">
          {entries.map((e, i) => (
            <div key={i} className={`rounded-lg px-2 py-1.5 bg-black/20 border border-white/5 ${expanded === i ? "bg-black/30" : ""}`}>
              <button onClick={() => setExpanded(expanded === i ? null : i)} className="w-full text-left flex gap-2 items-start">
                <span className={`text-[10px] font-mono shrink-0 mt-0.5 ${phaseColor(e.phase)}`}>{e.phase ?? "?"}</span>
                <span className="text-xs opacity-80 break-all leading-relaxed flex-1">{preview(e)}</span>
                <span className="text-[10px] opacity-30 shrink-0">{e.timestamp ? new Date(e.timestamp as string).toLocaleTimeString() : ""}</span>
              </button>
              {expanded === i && (
                <pre className="mt-2 text-[11px] leading-relaxed whitespace-pre-wrap break-all bg-black/40 rounded p-2 max-h-[300px] overflow-auto">
                  {JSON.stringify(e, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-2 pt-2 border-t border-white/5">
          <div className="text-[11px] opacity-40 mb-1">Per-request files — full untruncated traces:</div>
          <div className="flex flex-wrap gap-1">
            {files.map((f) => (
              <button key={f} onClick={() => void openFile(f)} className="px-2 py-1 rounded-full bg-white/5 hover:bg-white/10 text-[11px] font-mono">
                {f}
              </button>
            ))}
          </div>
        </div>
      )}

      {fullOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setFullOpen(false)}>
          <div className="bg-[#1c1c1c] border border-white/10 rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden" onClick={(ev) => ev.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-white/10">
              <span className="text-xs font-mono opacity-70 truncate">{selectedFileName}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const text = JSON.stringify(selectedFileContent, null, 2);
                    void navigator.clipboard.writeText(text);
                  }}
                  className="px-3 py-1 rounded-full neu-button text-xs"
                >
                  Copy
                </button>
                <button onClick={() => setFullOpen(false)} className="w-8 h-8 rounded-full bg-white/10 grid place-items-center">×</button>
              </div>
            </div>
            <pre className="p-3 text-xs leading-relaxed whitespace-pre-wrap break-all overflow-auto flex-1">{JSON.stringify(selectedFileContent, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
