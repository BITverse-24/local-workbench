import React, { useEffect, useState } from 'react';
import * as wb from '../lib/workbench';

export default function TitleBar() {
  const [devOpenRouter, setDevOpenRouter] = useState(false);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    wb.getDevMode()
      .then((status) => {
        setDevOpenRouter(status.devOpenRouter);
        setHasKey(status.hasOpenRouterKey);
      })
      .catch(() => {});
  }, []);

  const toggleDevMode = async () => {
    try {
      const nextVal = !devOpenRouter;
      const res = await wb.setDevMode(nextVal);
      setDevOpenRouter(res.devOpenRouter);
    } catch (err) {
      console.error("Failed to toggle dev mode:", err);
    }
  };

  return (
    <div
      className="h-10 flex items-center justify-between px-4 flex-shrink-0 z-20 neu-titlebar select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3">
        <span className="text-[13px] font-semibold tracking-[0.02em] text-[var(--text-primary)]">
          Sovereign Workbench
        </span>
        {devOpenRouter ? (
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-warning)]" />
            Dev workload · OpenRouter active
          </span>
        ) : (
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-success)]" />
            Air-gapped · zero egress
          </span>
        )}
      </div>
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          onClick={toggleDevMode}
          className={`px-3 py-1 rounded-[var(--radius-sm)] text-xs font-mono font-medium transition-colors border bg-transparent ${
            devOpenRouter
              ? "text-[var(--status-warning)] border-[var(--status-warning)]/50"
              : "text-[var(--text-secondary)] border-[var(--border-default)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]"
          }`}
          title={
            devOpenRouter
              ? "Dev Mode ACTIVE: Requests routed to OpenRouter. Click to revert to DB local endpoints."
              : `Dev Mode INACTIVE: Requests strictly routed to DB local endpoints. Click to route to OpenRouter.${
                  !hasKey ? " (Note: OPENROUTER_API_KEY environment variable is required)" : ""
                }`
          }
        >
          Dev: OpenRouter [{devOpenRouter ? "ON" : "OFF"}]
        </button>

        <button
          type="button"
          onClick={async () => {
            try {
              if (window.workbench) {
                await window.workbench.resetOnboarding();
              }
              window.location.reload();
            } catch (e) {
              console.error("Failed to reset onboarding:", e);
              window.location.reload();
            }
          }}
          className="px-3 py-1 rounded-[var(--radius-sm)] text-xs font-mono font-medium text-[var(--text-secondary)] border border-[var(--border-default)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] bg-transparent transition-colors"
          title="Dev shortcut: Clear onboarding completion and reload to test onboarding again (caches your inputs)"
        >
          Dev: Reset Onboarding
        </button>

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

