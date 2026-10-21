import { useState } from "react";

type Props = {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onModelSettings: () => void;
  /** Active chat topic shown in the header. */
  title: string;
  runId?: string | null;
  children: React.ReactNode;
};

export default function ChatPanel({
  leftCollapsed,
  rightCollapsed,
  onToggleLeft,
  onToggleRight,
  onModelSettings,
  title,
  runId,
  children,
}: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopyRunId = async () => {
    if (!runId) return;
    try {
      await navigator.clipboard.writeText(runId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn("Failed to copy run ID:", err);
    }
  };

  return (
    <main className="chat-panel flex-1 flex flex-col min-w-0 min-h-0 neu-panel overflow-hidden">
      <header className="h-[56px] min-w-0 flex items-center justify-between px-3 gap-2 flex-shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <div className="flex flex-1 min-w-0 items-center gap-2 sm:gap-3">
          <button onClick={onToggleLeft} aria-label="Toggle explorer" aria-expanded={!leftCollapsed} className="w-9 h-9 shrink-0 rounded-[var(--radius-sm)] neu-button grid place-items-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title={leftCollapsed ? 'Expand explorer' : 'Collapse explorer'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg>
          </button>
          <h1 className="text-base min-w-0 font-semibold text-[var(--text-primary)] truncate" title={title}>{title}</h1>
          {runId && (
            <button
              type="button"
              onClick={handleCopyRunId}
              className="inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface-raised)] text-[11px] font-mono text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-default)] transition-colors cursor-pointer select-none"
              title={`Run ID: ${runId}\nClick to copy full ID`}
              aria-label="Copy Run ID"
            >
              {copied ? (
                <>
                  <svg className="w-3 h-3 text-[var(--status-success)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span className="text-[var(--status-success)] font-medium">Copied!</span>
                </>
              ) : (
                <>
                  <svg className="w-3 h-3 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  <span>{runId.slice(0, 8)}</span>
                </>
              )}
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={onModelSettings} className="h-9 px-3 rounded-[var(--radius-sm)] neu-button text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            Model Settings
          </button>
          <button onClick={onToggleRight} aria-label="Toggle settings" aria-expanded={!rightCollapsed} className="w-9 h-9 rounded-[var(--radius-sm)] neu-button grid place-items-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title={rightCollapsed ? 'Expand settings' : 'Collapse settings'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg>
          </button>
        </div>
      </header>
      {children}
    </main>
  );
}
