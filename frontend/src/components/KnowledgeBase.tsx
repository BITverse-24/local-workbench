import { useState, useEffect, useCallback, useRef } from "react";
import * as wb from "../lib/workbench";

export default function KnowledgeBase() {
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [stats, setStats] = useState<RAGStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Query test
  const [queryText, setQueryText] = useState("");
  const [queryResults, setQueryResults] = useState<RetrievalResult[]>([]);
  const [queryLoading, setQueryLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    if (!wb.isWorkbenchAvailable()) return;
    setLoading(true);
    try {
      const [dList, s] = await Promise.all([wb.kbListDocs(), wb.kbStats()]);
      setDocs(dList);
      setStats(s);
    } catch (err) {
      console.warn("Failed to load KB data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIngesting(true);
    setStatusMessage(`Reading ${file.name}...`);

    try {
      // In Electron environment, File object from input often has .path property
      const filePath = (file as any).path || file.name;
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      const docId = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

      const res = await wb.kbIngestDoc({
        doc_id: docId,
        title: baseName.toUpperCase(),
        source_path: filePath,
        doc_type: "sop",
        department: "Engineering Standards",
        effective_date: new Date().toISOString().split("T")[0],
        page_count: 1,
        ocr_used: false,
      });

      setStatusMessage(`Successfully indexed ${res.chunkCount} clauses from ${file.name}`);
      await refresh();
    } catch (err: any) {
      setStatusMessage(`Failed to ingest: ${err.message || String(err)}`);
    } finally {
      setIngesting(false);
      if (e.target) e.target.value = "";
      setTimeout(() => setStatusMessage(null), 5000);
    }
  };

  const handleDelete = async (docId: string) => {
    try {
      await wb.kbDeleteDoc(docId);
      await refresh();
    } catch (err) {
      console.error("Failed to delete doc:", err);
    }
  };

  const handleReindex = async (docId?: string) => {
    setLoading(true);
    try {
      const res = await wb.kbReindex(docId);
      setStatusMessage(`Re-indexed ${res.chunksIndexed} chunks.`);
      await refresh();
    } catch (err: any) {
      setStatusMessage(`Re-index failed: ${err.message || String(err)}`);
    } finally {
      setLoading(false);
      setTimeout(() => setStatusMessage(null), 5000);
    }
  };

  const handleTestQuery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!queryText.trim()) return;
    setQueryLoading(true);
    try {
      const res = await wb.kbQuery(queryText, 3);
      setQueryResults(res.results);
    } catch (err) {
      console.warn("Query failed:", err);
    } finally {
      setQueryLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden text-xs text-white/80 select-none">
      {/* Header & Stats Banner */}
      <div className="p-3 border-b border-white/5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-white/90 text-sm">Knowledge Base</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => handleReindex()}
              disabled={loading || docs.length === 0}
              className="px-2 py-1 rounded-md neu-button text-[10px] text-white/70 hover:text-white"
              title="Re-index all documents"
            >
              Reindex All
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={ingesting}
              className="px-2.5 py-1 rounded-md neu-button-primary text-[10px] font-medium flex items-center gap-1"
              title="Add Document (.pdf, .txt, .md)"
            >
              ＋ Add SOP
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept=".pdf,.txt,.md"
              onChange={handleFileSelect}
            />
          </div>
        </div>

        {/* Stats Strip */}
        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="p-2 rounded-xl neu-pressed">
            <div className="text-[10px] opacity-50 uppercase tracking-wider">Documents</div>
            <div className="text-base font-bold text-white mt-0.5">{stats?.docCount ?? docs.length}</div>
          </div>
          <div className="p-2 rounded-xl neu-pressed">
            <div className="text-[10px] opacity-50 uppercase tracking-wider">Indexed Clauses</div>
            <div className="text-base font-bold text-emerald-400 mt-0.5">{stats?.chunkCount ?? 0}</div>
          </div>
        </div>

        {statusMessage && (
          <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] leading-snug animate-apple-fadeIn">
            {statusMessage}
          </div>
        )}
      </div>

      {/* Document List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        <div className="text-[11px] font-medium text-white/40 uppercase tracking-wider px-1">
          Registered Standards ({docs.length})
        </div>

        {docs.length === 0 ? (
          <div className="p-4 text-center rounded-2xl neu-pressed opacity-50 space-y-1">
            <div>No standards ingested yet.</div>
            <div className="text-[10px] opacity-70">
              Click &quot;＋ Add SOP&quot; to index technical criteria and standard operating procedures.
            </div>
          </div>
        ) : (
          docs.map((d) => (
            <div
              key={d.doc_id}
              className="p-3 rounded-2xl neu-card space-y-1.5 transition-all hover:brightness-105"
            >
              <div className="flex items-start justify-between gap-1">
                <div className="min-w-0">
                  <div className="font-semibold text-white truncate text-xs" title={d.title}>
                    {d.title}
                  </div>
                  <div className="text-[10px] opacity-50 truncate" title={d.source_path}>
                    ID: {d.doc_id} • {d.department}
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(d.doc_id)}
                  className="p-1 rounded-md hover:bg-red-500/20 hover:text-red-300 text-white/30 shrink-0 transition"
                  title="Remove document from KB"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              <div className="flex items-center justify-between text-[10px] pt-1 border-t border-white/5 opacity-70">
                <span>{d.chunk_count ?? 0} clauses</span>
                <span>{d.effective_date || "Active"}</span>
              </div>
            </div>
          ))
        )}

        {/* Test Retrieval Box */}
        <div className="pt-3 border-t border-white/5 space-y-2">
          <div className="text-[11px] font-medium text-white/40 uppercase tracking-wider px-1">
            Test SOP Query
          </div>
          <form onSubmit={handleTestQuery} className="flex gap-1.5">
            <input
              type="text"
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="e.g. wall thinning limit..."
              className="flex-1 px-2.5 py-1.5 rounded-xl neu-pressed bg-transparent outline-none text-xs text-white placeholder:text-white/20"
            />
            <button
              type="submit"
              disabled={queryLoading || !queryText.trim()}
              className="px-3 py-1.5 rounded-xl neu-button text-xs shrink-0"
            >
              {queryLoading ? "..." : "Search"}
            </button>
          </form>

          {queryResults.length > 0 && (
            <div className="space-y-1.5 mt-2">
              {queryResults.map((r, i) => (
                <div key={i} className="p-2 rounded-xl neu-pressed text-[11px] space-y-1">
                  <div className="flex items-center justify-between text-emerald-400 font-semibold text-[10px]">
                    <span>§{r.section_label || "Clause"} ({r.doc_id})</span>
                    <span className="opacity-70">Score: {r.score.toFixed(3)}</span>
                  </div>
                  <div className="opacity-80 line-clamp-3 leading-relaxed select-text cursor-text font-mono text-[10px]">
                    {r.text}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
