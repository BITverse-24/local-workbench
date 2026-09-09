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
    <main className="flex-1 flex flex-col min-w-0 neu-panel overflow-hidden animate-apple-center delay-100">
      <header className="h-[56px] flex items-center justify-between px-5 md:px-6 flex-shrink-0 neu-header animate-apple-fade delay-300">
        <div className="flex items-center gap-2">
          <button onClick={onToggleLeft} className="w-8 h-8 rounded-full neu-button grid place-items-center hidden md:grid" title={leftCollapsed ? 'Expand history' : 'Collapse history'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg>
          </button>
          <h1 className="text-[15px] font-semibold tracking-tight truncate max-w-[40vw]" title={title}>{title}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onToggleRight} className="w-8 h-8 rounded-full neu-button grid place-items-center hidden lg:grid" title={rightCollapsed ? 'Expand settings' : 'Collapse settings'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg>
          </button>
        </div>
      </header>
      {children}
    </main>
  );
}
