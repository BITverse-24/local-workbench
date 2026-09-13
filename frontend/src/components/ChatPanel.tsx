type Props = {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  /** Active chat topic shown in the header. */
  title: string;
  children: React.ReactNode;
};

export default function ChatPanel({ leftCollapsed, rightCollapsed, onToggleLeft, onToggleRight, title, children }: Props) {
  return (
    <main className="flex-1 flex flex-col min-w-0 neu-panel overflow-hidden">
      <header className="h-[56px] flex items-center justify-between px-5 md:px-6 flex-shrink-0 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
        <div className="flex items-center gap-3">
          <button onClick={onToggleLeft} className="w-9 h-9 rounded-[var(--radius-sm)] neu-button grid place-items-center hidden md:grid text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title={leftCollapsed ? 'Expand explorer' : 'Collapse explorer'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg>
          </button>
          <h1 className="text-base font-semibold text-[var(--text-primary)] truncate max-w-[40vw]" title={title}>{title}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onToggleRight} className="w-9 h-9 rounded-[var(--radius-sm)] neu-button grid place-items-center hidden lg:grid text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title={rightCollapsed ? 'Expand settings' : 'Collapse settings'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg>
          </button>
        </div>
      </header>
      {children}
    </main>
  );
}
