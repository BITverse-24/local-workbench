type Props = {
  collapsed: boolean;
  onCollapse: () => void;
};

export default function LeftSidebar({ collapsed, onCollapse }: Props) {
  return (
    <aside
      className={`hidden md:flex flex-col neu-panel flex-shrink-0 overflow-hidden ${!collapsed ? 'animate-apple-left' : ''}`}
      style={{
        width: collapsed ? 0 : 280,
        minWidth: collapsed ? 0 : 280,
        opacity: collapsed ? 0 : 1,
        transform: collapsed ? 'translateX(-12px) scale(0.98)' : 'translateX(0) scale(1)',
        padding: collapsed ? 0 : '16px',
        borderWidth: collapsed ? 0 : '1px',
        pointerEvents: collapsed ? 'none' : 'auto',
        transition: 'width 0.6s cubic-bezier(0.16,1,0.3,1), opacity 0.45s cubic-bezier(0.16,1,0.3,1), transform 0.6s cubic-bezier(0.16,1,0.3,1), padding 0.5s cubic-bezier(0.16,1,0.3,1), border-width 0.4s',
        willChange: 'width, transform, opacity',
      } as React.CSSProperties}
    >
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="text-[11px] font-semibold tracking-[0.16em] uppercase opacity-50 whitespace-nowrap">History</div>
        <div className="flex items-center gap-1.5">
          <button onClick={onCollapse} className="w-7 h-7 rounded-full neu-button grid place-items-center text-xs shrink-0" title="Collapse">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button className="w-7 h-7 rounded-full neu-button grid place-items-center text-sm shrink-0">＋</button>
        </div>
      </div>

      <button className="w-full text-left p-3.5 rounded-2xl text-sm flex flex-col gap-1 neu-pressed animate-apple-message">
        <span className="font-medium leading-tight">What is the capital of France?</span>
        <span className="text-xs opacity-50">vision → draft</span>
      </button>

      <div className="flex-1 overflow-y-auto space-y-3 mt-3 pr-1">
        <button className="w-full text-left p-3 rounded-2xl neu-card hover:brightness-110 text-sm animate-apple-message delay-100" style={{ transition: 'all 0.5s var(--apple-ease)' }}>
          <div className="truncate opacity-80">Write a Python script for CSV parsing…</div>
          <div className="text-xs opacity-40 mt-1">code</div>
        </button>
        <button className="w-full text-left p-3 rounded-2xl neu-card hover:brightness-110 text-sm animate-apple-message delay-200" style={{ transition: 'all 0.5s var(--apple-ease)' }}>
          <div className="truncate opacity-80">Explain quantum computing</div>
          <div className="text-xs opacity-40 mt-1">draft</div>
        </button>
        <button className="w-full text-left p-3 rounded-2xl neu-card hover:brightness-110 text-sm animate-apple-message delay-300" style={{ transition: 'all 0.5s var(--apple-ease)' }}>
          <div className="truncate opacity-80">Inspection report → approval note</div>
          <div className="text-xs opacity-40 mt-1">Flow A ✓</div>
        </button>
      </div>
    </aside>
  );
}
