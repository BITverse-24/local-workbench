import { useState, useEffect, useCallback, useRef } from 'react';
import * as wb from '../../lib/workbench';

type Props = {
  isExpanded?: boolean;
  onToggleExpand?: () => void;
};

export default function KnowledgePanel({
  isExpanded: controlledExpanded,
  onToggleExpand: controlledToggle,
}: Props) {
  const [internalExpanded, setInternalExpanded] = useState(true);
  const isExpanded = controlledExpanded !== undefined ? controlledExpanded : internalExpanded;
  const onToggleExpand = controlledToggle || (() => setInternalExpanded((p) => !p));
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
      const baseName = file.name.replace(/\.[^/.]+$/, '') || 'document';
      const docId = (baseName.toLowerCase().replace(/[^a-z0-9_-]/g, '-') || `doc-${Date.now()}`).slice(0, 80);
      const title = (baseName.trim() || 'Untitled Document').slice(0, 200);

      const res = await wb.kbIngestDoc({
        doc_id: docId,
        title,
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
      className={`flex flex-col transition-all duration-200 ${
        isExpanded ? 'min-h-0' : 'shrink-0'
      }`}
    >
      {/* Section Header */}
      <div className="flex items-center justify-between py-1.5 px-1 shrink-0 select-none">
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1.5 text-left group hover:opacity-100 transition-opacity"
          title={isExpanded ? 'Collapse knowledge' : 'Expand knowledge'}
        >
          <span
            className={`text-[11px] text-white/40 group-hover:text-white/80 transition-transform duration-200 ${
              isExpanded ? 'rotate-0' : '-rotate-90'
            }`}
          >
            ▾
          </span>
          <div className="flex items-center gap-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[var(--text-tertiary)]"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            <span className="text-sm font-semibold text-[var(--text-secondary)] tracking-normal group-hover:text-[var(--text-primary)] transition-colors">
              Knowledge (SOP)
            </span>
            <span className="text-xs px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] font-mono">
              {stats?.docCount ?? docs.length}
            </span>
          </div>
        </button>

        <div className="flex items-center gap-1">
          <button
            onClick={() => handleReindex()}
            disabled={loading || docs.length === 0}
            className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-30"
            title="Re-index all documents"
            aria-label="Re-index all documents"
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
              className={loading ? 'animate-spin text-[var(--accent)]' : ''}
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={ingesting}
            className="h-7.5 px-3 rounded-[var(--radius-sm)] neu-button text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1.5 transition-colors disabled:opacity-40"
            title="Add Document (.pdf, .docx, .txt, .md, .csv)"
          >
            <span>＋</span>
            <span>Add</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.docx,.doc,.txt,.md,.markdown,.csv,.json"
            onChange={handleFileSelect}
          />
        </div>
      </div>

      {/* Expanded Content Area */}
      {isExpanded && (
        <div className="flex flex-col overflow-hidden pt-1 space-y-2">
          {/* Summary stats badge */}
          <div className="flex items-center justify-between px-2.5 py-1.5 mb-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] shrink-0">
            <span>Indexed Standards</span>
            <span className="text-[var(--text-primary)] font-mono font-medium">
              {stats?.chunkCount ?? 0} clauses
            </span>
          </div>

          {/* Status message banner */}
          {statusMessage && (
            <div className="px-2.5 py-1.5 mb-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-secondary)] text-xs flex items-center justify-between shrink-0">
              <span className="truncate">{statusMessage}</span>
              <button onClick={() => setStatusMessage(null)} className="opacity-50 hover:opacity-100 ml-1">
                ✕
              </button>
            </div>
          )}

          {/* Search Filter if > 4 docs */}
          {docs.length > 4 && (
            <div className="relative flex items-center mb-2 px-0.5 shrink-0">
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filter standards…"
                className="w-full bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs sm:text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--border-default)]"
              />
              {searchFilter && (
                <button
                  onClick={() => setSearchFilter('')}
                  className="absolute right-2 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                  ✕
                </button>
              )}
            </div>
          )}

          {/* Standards Document List */}
          <div className="max-h-56 overflow-y-auto space-y-1 pr-0.5">
            {filteredDocs.length > 0 ? (
              filteredDocs.map((d) => (
                <div
                  key={d.doc_id}
                  className="group p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] hover:bg-[var(--bg-surface-raised)] transition-colors flex items-center justify-between gap-2"
                >
                  <div className="min-w-0 flex items-center gap-2.5 flex-1">
                    <div className="w-6 h-6 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-secondary)] flex items-center justify-center text-xs shrink-0 font-mono">
                      §
                    </div>
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="font-medium text-[var(--text-primary)] text-sm truncate" title={d.title}>
                        {d.title}
                      </div>
                      <div className="text-xs text-[var(--text-tertiary)] font-mono truncate mt-0.5">
                        {d.chunk_count ?? 0} clauses • {d.doc_id}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleDelete(d.doc_id)}
                    className="w-6 h-6 rounded-[var(--radius-sm)] hover:bg-[var(--bg-surface-raised)] hover:text-[var(--status-error)] text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 grid place-items-center shrink-0 transition"
                    title="Remove standard"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))
            ) : (
              <div className="p-3.5 text-center rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-subtle)] opacity-60 space-y-1 my-auto">
                <div className="text-xs text-[var(--text-secondary)]">
                  {searchFilter ? 'No matching standards' : 'No standards ingested'}
                </div>
                <div className="text-xs text-[var(--text-tertiary)]">
                  Upload PDF, Markdown, or text SOPs for context grounding.
                </div>
              </div>
            )}
          </div>

          {/* Test Retrieval Collapsible Trigger */}
          <div className="pt-1.5 mt-1.5 border-t border-[var(--border-subtle)] shrink-0">
            <button
              onClick={() => setQueryExpanded(!queryExpanded)}
              className="w-full flex items-center justify-between py-1.5 px-2 rounded-[var(--radius-sm)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-raised)] transition-colors"
            >
              <span className="flex items-center gap-1.5 font-medium">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-tertiary)]">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                Test query
              </span>
              <span className={`text-[10px] transition-transform ${queryExpanded ? 'rotate-180' : ''}`}>
                ▾
              </span>
            </button>

            {queryExpanded && (
              <div className="mt-1.5 space-y-2 p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                <form onSubmit={handleTestQuery} className="flex gap-1.5">
                  <input
                    type="text"
                    value={queryText}
                    onChange={(e) => setQueryText(e.target.value)}
                    placeholder="Search clause…"
                    className="flex-1 px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-default)] text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                  />
                  <button
                    type="submit"
                    disabled={queryLoading || !queryText.trim()}
                    className="px-3 py-1.5 rounded-[var(--radius-sm)] neu-button text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0 font-medium"
                  >
                    {queryLoading ? '…' : 'Run'}
                  </button>
                </form>

                {queryResults.length > 0 && (
                  <div className="max-h-32 overflow-y-auto space-y-1.5">
                    {queryResults.map((r, i) => (
                      <div key={i} className="p-2 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-xs leading-snug">
                        <span className="text-[var(--accent)] font-medium">§{r.section_label || 'Clause'}:</span>{' '}
                        <span className="text-[var(--text-secondary)] line-clamp-2 select-text">{r.text}</span>
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
