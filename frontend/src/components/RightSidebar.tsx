import RunTelemetryWidget from "./RunTelemetryWidget";

type Model = { id: string; name: string; desc: string };

type Props = {
  collapsed: boolean;
  onCollapse: () => void;
  models: Model[];
  selectedModel: Model;
  modelOpen: boolean;
  setModelOpen: (v: boolean) => void;
  modelBtnRef: React.RefObject<HTMLButtonElement | null>;
  temperature: number;
  setTemperature: (n: number) => void;
  activeRoute?: { taskType: string; modelId: string; reason: string } | null;
  runState?: string | null;
  health?: ModelHealth[] | null;
  healthLoading?: boolean;
  onRefreshHealth?: () => void;
  runEvents?: RunEvent[];
  runId?: string | null;
};

export default function RightSidebar({
  collapsed,
  onCollapse,
  models: _models,
  selectedModel,
  modelOpen,
  setModelOpen,
  modelBtnRef,
  temperature,
  setTemperature,
  activeRoute,
  runState,
  health,
  healthLoading,
  onRefreshHealth,
  runEvents,
  runId,
}: Props) {
  const isRunning = runState != null && !["completed", "failed", "cancelled"].includes(runState);
  return (
    <aside
      className={`hidden lg:flex flex-col neu-panel overflow-hidden flex-shrink-0 ${!collapsed ? "animate-apple-right delay-200" : ""}`}
      style={{
        width: collapsed ? 0 : 340,
        minWidth: collapsed ? 0 : 340,
        opacity: collapsed ? 0 : 1,
        transform: collapsed ? "translateX(12px) scale(0.98)" : "translateX(0) scale(1)",
        padding: collapsed ? 0 : undefined,
        borderWidth: collapsed ? 0 : "1px",
        pointerEvents: collapsed ? "none" : "auto",
        transition:
          "width 0.6s cubic-bezier(0.16,1,0.3,1), opacity 0.45s cubic-bezier(0.16,1,0.3,1), transform 0.6s cubic-bezier(0.16,1,0.3,1), padding 0.5s cubic-bezier(0.16,1,0.3,1)",
        willChange: "width, transform, opacity",
      } as React.CSSProperties}
    >
      <div className="p-4 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)]">
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-primary)] tracking-normal">Settings</h2>
        </div>
        <button onClick={onCollapse} className="w-8 h-8 rounded-[var(--radius-sm)] neu-button grid place-items-center shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Collapse">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-[var(--text-secondary)]">Model route {isRunning ? "(locked during run)" : "(preference)"}</label>
          <button
            ref={modelBtnRef as React.RefObject<HTMLButtonElement>}
            onClick={() => !isRunning && setModelOpen(!modelOpen)}
            disabled={isRunning}
            className={`w-full rounded-[var(--radius-md)] p-3 neu-raised flex items-center justify-between text-left ${isRunning ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            <div>
              <div className="text-sm font-medium text-[var(--text-primary)]">{activeRoute ? `${activeRoute.taskType} → ${activeRoute.modelId}` : selectedModel.name}</div>
              <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{activeRoute ? `Reason: ${activeRoute.reason}` : selectedModel.desc}</div>
            </div>
            <span
              className={`w-6 h-6 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs transition-transform duration-150 ${modelOpen ? "rotate-180" : "rotate-0"}`}
            >
              ▾
            </span>
          </button>
          {activeRoute && <div className="text-xs text-[var(--text-tertiary)]">Backend controls routing for locked flows; this display reflects the active route.</div>}
        </div>

        <div className="space-y-2 p-3.5 rounded-[var(--radius-md)] neu-card">
          <div className="flex justify-between items-center">
            <label className="text-sm font-medium text-[var(--text-secondary)]">Temperature</label>
            <span className="text-xs px-2 py-0.5 rounded-[var(--radius-sm)] neu-pressed font-mono text-[var(--text-primary)]">{temperature.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-[var(--bg-surface)] accent-[var(--accent)]"
          />
          <div className="flex justify-between text-xs text-[var(--text-tertiary)]">
            <span>Precise</span>
            <span>Creative</span>
          </div>
        </div>

        <div className="space-y-2 p-3 rounded-[var(--radius-md)] neu-card">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-[var(--text-secondary)]">Service health</span>
            <button onClick={onRefreshHealth} disabled={!!healthLoading} className="px-2.5 py-1 rounded-[var(--radius-sm)] neu-button text-xs font-medium disabled:opacity-40">
              {healthLoading ? "…" : "Refresh"}
            </button>
          </div>
          {!health ? (
            <div className="text-xs text-[var(--text-tertiary)]">No health data yet.</div>
          ) : (
            <div className="space-y-2">
              {health.map((h) => (
                <div key={h.modelId} className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${h.available ? "bg-[var(--status-success)]" : "bg-[var(--status-error)]"}`} />
                  <span className="font-medium text-[var(--text-primary)] font-mono text-xs">{h.modelId}</span>
                  <span className="text-[var(--text-tertiary)]">{h.available ? "available" : "unavailable"}</span>
                  {h.latencyMs !== undefined && <span className="ml-auto text-[var(--text-tertiary)] font-mono text-xs">{h.latencyMs}ms</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-[var(--text-secondary)]">Max tokens</label>
          <input type="number" defaultValue={2048} className="w-full rounded-[var(--radius-sm)] p-2.5 text-sm outline-none neu-input font-mono" />
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-[var(--text-secondary)]">System instructions</label>
          <textarea
            rows={4}
            placeholder="You are a helpful assistant…"
            className="w-full rounded-[var(--radius-sm)] p-2.5 text-sm outline-none resize-none neu-input placeholder:text-[var(--text-tertiary)]"
          ></textarea>
        </div>

        <RunTelemetryWidget runEvents={runEvents} runId={runId} />
      </div>
    </aside>
  );
}

