type Props = {
  health: ModelHealth[] | null;
  loading: boolean;
  onRefresh: () => void;
};

export default function HealthPanel({ health, loading, onRefresh }: Props) {
  return (
    <div className="space-y-2 p-3 rounded-[var(--radius-md)] neu-card border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--text-secondary)]">Service health</span>
        <button onClick={onRefresh} disabled={loading} className="px-2.5 py-0.5 rounded-[var(--radius-sm)] neu-button text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40">{loading ? "..." : "Refresh"}</button>
      </div>
      {!health ? (
        <div className="text-xs text-[var(--text-tertiary)]">No health data yet.</div>
      ) : (
        <div className="space-y-1.5">
          {health.map((h) => (
            <div key={h.modelId} className="flex items-center gap-2 text-xs">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${h.available ? "bg-[var(--status-success)]" : "bg-[var(--status-error)]"}`} />
              <span className="font-mono text-xs text-[var(--text-primary)]">{h.modelId}</span>
              <span className="text-[var(--text-tertiary)]">{h.available ? "available" : "unavailable"}</span>
              {h.latencyMs !== undefined && <span className="ml-auto font-mono text-[10px] text-[var(--text-tertiary)]">{h.latencyMs}ms</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
