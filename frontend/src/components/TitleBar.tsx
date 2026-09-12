export default function TitleBar() {
  return (
    <div
      className="h-9 flex items-center justify-between px-4 flex-shrink-0 z-20 neu-titlebar animate-apple-title"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold tracking-[0.18em] uppercase opacity-70">Sovereign Workbench</span>
        <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-[10px] font-medium text-emerald-400 tracking-wider">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          AIR-GAPPED • ZERO EGRESS
        </span>
      </div>
      <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => (window as unknown as { electronAPI?: { minimize?: () => void } }).electronAPI?.minimize?.()}
          className="w-8 h-7 grid place-items-center neu-button text-xs"
        >
          ─
        </button>
        <button
          onClick={() => (window as unknown as { electronAPI?: { maximize?: () => void } }).electronAPI?.maximize?.()}
          className="w-8 h-7 grid place-items-center neu-button text-xs"
        >
          □
        </button>
        <button
          onClick={() => (window as unknown as { electronAPI?: { close?: () => void } }).electronAPI?.close?.()}
          className="w-8 h-7 grid place-items-center neu-button text-xs hover:!text-white"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
