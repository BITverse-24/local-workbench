import React from 'react';

export default function TitleBar() {
  return (
    <div
      className="h-10 flex items-center justify-between px-4 flex-shrink-0 z-20 neu-titlebar select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3">
        <span className="text-[13px] font-semibold tracking-[0.02em] text-[var(--text-primary)]">
          Local Workbench
        </span>
      </div>
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="flex items-center gap-1 ml-1">
          <button
            onClick={() => (window as unknown as { electronAPI?: { minimize?: () => void } }).electronAPI?.minimize?.()}
            className="w-8 h-7 rounded-[var(--radius-sm)] grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-raised)] border border-transparent hover:border-[var(--border-subtle)] transition-colors"
          >
            ─
          </button>
          <button
            onClick={() => (window as unknown as { electronAPI?: { maximize?: () => void } }).electronAPI?.maximize?.()}
            className="w-8 h-7 rounded-[var(--radius-sm)] grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-raised)] border border-transparent hover:border-[var(--border-subtle)] transition-colors"
          >
            □
          </button>
          <button
            onClick={() => (window as unknown as { electronAPI?: { close?: () => void } }).electronAPI?.close?.()}
            className="w-8 h-7 rounded-[var(--radius-sm)] grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--status-error)] hover:bg-[var(--bg-surface-raised)] border border-transparent hover:border-[var(--border-subtle)] transition-colors"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
