type Props = {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onModelSettings: () => void;
  /** Active chat topic shown in the header. */
  title: string;
  children: React.ReactNode;
};

export default function ChatPanel({ leftCollapsed, rightCollapsed, onToggleLeft, onToggleRight, onModelSettings, title, children }: Props) {
  return (
    <main className="chat-panel flex-1 flex flex-col min-w-0 min-h-0 neu-panel overflow-hidden">
      <header className="h-[56px] min-w-0 flex items-center justify-between px-3 gap-2 flex-shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <div className="flex flex-1 min-w-0 items-center gap-3">
          <button onClick={onToggleLeft} aria-label="Toggle explorer" aria-expanded={!leftCollapsed} className="w-9 h-9 shrink-0 rounded-[var(--radius-sm)] neu-button grid place-items-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title={leftCollapsed ? 'Expand explorer' : 'Collapse explorer'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg>
          </button>
          <h1 className="text-base min-w-0 font-semibold text-[var(--text-primary)] truncate" title={title}>{title}</h1>
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
