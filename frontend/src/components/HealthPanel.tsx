type Props = {
  health: ModelHealth[] | null;
  loading: boolean;
  onRefresh: () => void;
};

export default function HealthPanel({ health, loading, onRefresh }: Props) {
  return (
    <div className="space-y-2 p-3 rounded-2xl neu-card">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium opacity-60">Service health</span>
        <button onClick={onRefresh} disabled={loading} className="px-2.5 py-1 rounded-full neu-button text-xs disabled:opacity-40">{loading ? "..." : "Refresh"}</button>
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
  );
}
