import { useState, useEffect, useCallback, useRef } from 'react';
import * as wb from '../../lib/workbench';

type Props = {
  isExpanded?: boolean;
  onToggleExpand?: () => void;
};

export default function KnowledgePanel({
  isExpanded = true,
  onToggleExpand,
}: Props) {
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [stats, setStats] = useState<RAGStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');

  // Test query drawer
  const [queryExpanded, setQueryExpanded] = useState(false);
  const [queryText, setQueryText] = useState('');
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
      console.warn('Failed to load KB data:', err);
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
    setStatusMessage(`Indexing ${file.name}...`);

    try {
      const filePath = (file as any).path || file.name;
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      const docId = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

      const res = await wb.kbIngestDoc({
        doc_id: docId,
        title: baseName.toUpperCase(),
        source_path: filePath,
        doc_type: 'sop',
        department: 'Engineering Standards',
        effective_date: new Date().toISOString().split('T')[0],
        page_count: 1,
        ocr_used: false,
      });

      setStatusMessage(`Indexed ${res.chunkCount} clauses from ${file.name}`);
      await refresh();
    } catch (err: any) {
      setStatusMessage(`Ingest failed: ${err.message || String(err)}`);
    } finally {
      setIngesting(false);
      if (e.target) e.target.value = '';
      setTimeout(() => setStatusMessage(null), 5000);
    }
  };

  const handleDelete = async (docId: string) => {
    try {
      await wb.kbDeleteDoc(docId);
      await refresh();
    } catch (err) {
      console.error('Failed to delete doc:', err);
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
      console.warn('Query failed:', err);
    } finally {
      setQueryLoading(false);
    }
  };

  const filteredDocs = searchFilter
    ? docs.filter(
        (d) =>
          d.title.toLowerCase().includes(searchFilter.toLowerCase()) ||
          d.doc_id.toLowerCase().includes(searchFilter.toLowerCase())
      )
    : docs;

  return (
    <div
      className={`flex flex-col transition-all duration-200 overflow-hidden ${
        isExpanded ? 'flex-1 min-h-0' : 'shrink-0'
      }`}
    >
      {/* Section Header */}
      <div className="flex items-center justify-between py-1 px-1 shrink-0 select-none">
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1.5 text-left group hover:opacity-100 transition-opacity"
          title={isExpanded ? 'Collapse knowledge' : 'Expand knowledge'}
        >
          <span
            className={`text-[10px] text-white/40 group-hover:text-white/80 transition-transform duration-200 ${
              isExpanded ? 'rotate-0' : '-rotate-90'
            }`}
          >
            ▾
          </span>
          <div className="flex items-center gap-1.5">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-emerald-400"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/70 group-hover:text-white transition-colors">
              Knowledge (SOP)
            </span>
            <span className="text-[9px] px-1.5 py-0.2 rounded-full neu-pressed text-emerald-400 font-mono">
              {stats?.docCount ?? docs.length}
            </span>
          </div>
        </button>

        <div className="flex items-center gap-1">
          <button
            onClick={() => handleReindex()}
            disabled={loading || docs.length === 0}
            className="p-1 rounded-full neu-button text-white/50 hover:text-white transition-colors disabled:opacity-30"
            title="Re-index all documents"
            aria-label="Re-index all documents"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={loading ? 'animate-spin text-emerald-400' : ''}
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={ingesting}
            className="px-2 py-0.5 rounded-full neu-button text-[11px] font-medium text-emerald-300 hover:text-emerald-200 flex items-center gap-1 hover:border-emerald-500/30 transition-colors disabled:opacity-40"
            title="Add Document (.pdf, .txt, .md)"
          >
            <span>＋</span>
            <span>Add</span>
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

      {/* Expanded Content Area */}
      {isExpanded && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden pt-1">
          {/* Compact Stats Ribbon */}
          <div className="flex items-center justify-between px-2 py-0.5 mb-1 rounded-lg neu-pressed bg-[#181818] text-[9px] text-white/50 font-mono shrink-0 border border-white/[0.04]">
            <span className="flex items-center gap-1">
              <span className="w-1 h-1 rounded-full bg-emerald-400" />
              {stats?.docCount ?? docs.length} standards
            </span>
            <span className="text-emerald-400 font-semibold">
              {stats?.chunkCount ?? 0} indexed clauses
            </span>
          </div>

          {/* Status message banner */}
          {statusMessage && (
            <div className="px-2 py-1 mb-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[10px] flex items-center justify-between shrink-0">
              <span className="truncate">{statusMessage}</span>
              <button onClick={() => setStatusMessage(null)} className="opacity-50 hover:opacity-100 ml-1">
                ✕
              </button>
            </div>
          )}

          {/* Search Filter if > 4 docs */}
          {docs.length > 4 && (
            <div className="relative flex items-center mb-1.5 px-0.5 shrink-0">
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filter standards..."
                className="w-full bg-[#181818] border border-white/[0.06] rounded-lg px-2 py-0.5 text-[10px] text-white/80 placeholder:text-white/30 outline-none focus:border-white/20"
              />
              {searchFilter && (
                <button
                  onClick={() => setSearchFilter('')}
                  className="absolute right-2 text-[9px] text-white/40 hover:text-white"
                >
                  ✕
                </button>
              )}
            </div>
          )}

          {/* Standards Document List */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1 pr-1">
            {filteredDocs.length > 0 ? (
              filteredDocs.map((d) => (
                <div
                  key={d.doc_id}
                  className="group p-2 rounded-xl neu-card hover:bg-white/[0.03] transition-all flex items-center justify-between gap-1.5"
                >
                  <div className="min-w-0 flex items-center gap-2 flex-1">
                    <div className="w-5 h-5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center text-[10px] shrink-0">
                      §
                    </div>
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="font-medium text-white text-[11px] truncate" title={d.title}>
                        {d.title}
                      </div>
                      <div className="text-[9px] opacity-40 font-mono truncate">
                        {d.chunk_count ?? 0} clauses • {d.doc_id}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleDelete(d.doc_id)}
                    className="w-5 h-5 rounded-full hover:bg-red-500/20 hover:text-red-300 text-white/20 opacity-0 group-hover:opacity-100 grid place-items-center shrink-0 transition"
                    title="Remove standard"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))
            ) : (
              <div className="p-3 text-center rounded-xl neu-pressed opacity-50 space-y-1 my-auto">
                <div className="text-[11px] text-white/70">
                  {searchFilter ? 'No matching standards' : 'No standards ingested'}
                </div>
                <div className="text-[9px] opacity-60">
                  Upload PDF, Markdown, or text SOPs for context grounding.
                </div>
              </div>
            )}
          </div>

          {/* Test Retrieval Collapsible Trigger */}
          <div className="pt-1 mt-1 border-t border-white/[0.04] shrink-0">
            <button
              onClick={() => setQueryExpanded(!queryExpanded)}
              className="w-full flex items-center justify-between py-1 px-1.5 rounded-lg text-[10px] text-white/50 hover:text-white/80 hover:bg-white/[0.03] transition-colors"
            >
              <span className="flex items-center gap-1 font-medium">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                Test Query
              </span>
              <span className={`text-[8px] transition-transform ${queryExpanded ? 'rotate-180' : ''}`}>
                ▾
              </span>
            </button>

            {queryExpanded && (
              <div className="mt-1 space-y-1.5 p-2 rounded-lg neu-pressed bg-[#181818]">
                <form onSubmit={handleTestQuery} className="flex gap-1">
                  <input
                    type="text"
                    value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                    placeholder="Search clause..."
                    className="flex-1 px-2 py-1 rounded bg-black/20 border border-white/[0.06] text-[10px] text-white placeholder:text-white/30 outline-none"
                  />
                  <button
                    type="submit"
                    disabled={queryLoading || !queryText.trim()}
                    className="px-2 py-1 rounded neu-button text-[10px] text-white/80 shrink-0"
                  >
                    {queryLoading ? '...' : 'Run'}
                  </button>
                </form>

                {queryResults.length > 0 && (
                  <div className="max-h-24 overflow-y-auto space-y-1">
                    {queryResults.map((r, i) => (
                      <div key={i} className="p-1 rounded bg-black/30 text-[9px] leading-snug">
                        <span className="text-emerald-400 font-semibold">§{r.section_label || 'Clause'}:</span>{' '}
                        <span className="opacity-80 line-clamp-2 select-text">{r.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
