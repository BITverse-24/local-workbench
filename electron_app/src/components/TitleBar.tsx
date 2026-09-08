export default function TitleBar() {
  return (
    <div
      className="h-9 flex items-center justify-between px-4 flex-shrink-0 z-20 neu-titlebar animate-apple-title"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold tracking-[0.18em] uppercase opacity-60">agent fr</span>
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
