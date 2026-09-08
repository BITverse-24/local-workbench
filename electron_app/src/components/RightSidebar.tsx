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
      <div className="p-5 flex items-center justify-between gap-2" style={{ borderBottom: "1px solid #2A2A2A" }}>
        <div>
          <h2 className="text-[11px] font-semibold tracking-[0.16em] uppercase opacity-50">Settings</h2>
        </div>
        <button onClick={onCollapse} className="w-7 h-7 rounded-full neu-button grid place-items-center shrink-0" title="Collapse">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        <div className="space-y-2 animate-apple-message">
          <label className="text-xs font-medium opacity-60">Model route {isRunning ? "(locked during run)" : "(preference)"}</label>
          <button
            ref={modelBtnRef as React.RefObject<HTMLButtonElement>}
            onClick={() => !isRunning && setModelOpen(!modelOpen)}
            disabled={isRunning}
            className={`w-full rounded-2xl p-3 neu-raised flex items-center justify-between text-left ${isRunning ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            <div>
              <div className="text-sm font-medium">{activeRoute ? `${activeRoute.taskType} → ${activeRoute.modelId}` : selectedModel.name}</div>
              <div className="text-xs opacity-50">{activeRoute ? `Reason: ${activeRoute.reason}` : selectedModel.desc}</div>
            </div>
            <span
              className={`w-8 h-8 rounded-full neu-button grid place-items-center text-xs transition-transform duration-300 ${modelOpen ? "rotate-180" : "rotate-0"}`}
              style={{ transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)" }}
            >
              ▾
            </span>
          </button>
          {activeRoute && <div className="text-[11px] opacity-40">Backend controls routing for locked flows; this display reflects the active route.</div>}
        </div>

        <div className="space-y-3 p-4 rounded-2xl neu-card animate-apple-message delay-100">
          <div className="flex justify-between items-center">
            <label className="text-xs font-medium opacity-60">Temperature</label>
            <span className="text-xs px-2.5 py-1 rounded-full neu-pressed font-mono text-xs">{temperature.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={temperature}
            onChange={(e) => setTemperature(parseFloat(e.target.value))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-white"
            style={{
              background: `linear-gradient(to right, #FFFFFF 0%, #FFFFFF ${temperature * 100}%, #1A1A1A ${temperature * 100}%, #1A1A1A 100%)`,
              boxShadow: "inset 0 0 0 1px #2A2A2A",
            }}
          />
          <div className="flex justify-between text-[11px] opacity-30">
            <span>Precise</span>
            <span>Creative</span>
          </div>
        </div>

        <div className="space-y-2 p-3 rounded-2xl neu-card">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium opacity-60">Service health</span>
            <button onClick={onRefreshHealth} disabled={!!healthLoading} className="px-2.5 py-1 rounded-full neu-button text-xs disabled:opacity-40">
              {healthLoading ? "..." : "Refresh"}
            </button>
          </div>
          {!health ? (
            <div className="text-xs opacity-40">No health data yet.</div>
          ) : (
            <div className="space-y-1.5">
              {health.map((h) => (
                <div key={h.modelId} className="flex items-center gap-2 text-xs">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${h.available ? "bg-emerald-400" : "bg-red-400"}`} />
                  <span className="font-medium">{h.modelId}</span>
                  <span className="opacity-50">{h.available ? "available" : "unavailable"}</span>
                  {h.latencyMs !== undefined && <span className="ml-auto opacity-40">{h.latencyMs}ms</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium opacity-60">Max Tokens</label>
          <input type="number" defaultValue={2048} className="w-full rounded-2xl p-3 text-sm outline-none neu-input" />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium opacity-60">System Instructions</label>
          <textarea
            rows={4}
            placeholder="You are a helpful assistant..."
            className="w-full rounded-2xl p-3 text-sm outline-none resize-none neu-input placeholder:text-white/30"
          ></textarea>
        </div>
      </div>
    </aside>
  );
}

