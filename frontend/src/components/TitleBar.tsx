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
      className="h-9 flex items-center justify-between px-4 flex-shrink-0 z-20 neu-titlebar animate-apple-title"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold tracking-[0.18em] uppercase opacity-70">Sovereign Workbench</span>
        {devOpenRouter ? (
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-[10px] font-medium text-amber-400 tracking-wider font-mono">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            DEV WORKLOAD • OPENROUTER ACTIVE
          </span>
        ) : (
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-[10px] font-medium text-emerald-400 tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            AIR-GAPPED • ZERO EGRESS
          </span>
        )}
      </div>
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          type="button"
          onClick={toggleDevMode}
          className={`px-2.5 py-1 rounded-full text-[10px] font-mono font-medium transition-colors border ${
            devOpenRouter
              ? "text-amber-300 bg-amber-500/20 border-amber-500/40"
              : "text-neutral-400 bg-neutral-800/40 border-neutral-700 hover:text-neutral-200"
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
          className="px-2.5 py-1 rounded-full text-[10px] font-mono font-medium text-amber-300 bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 transition-colors"
          title="Dev shortcut: Clear onboarding completion and reload to test onboarding again (caches your inputs)"
        >
          Dev: Reset Onboarding
        </button>


        <div className="flex items-center gap-1.5 ml-1">
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
    </div>
  );
}

