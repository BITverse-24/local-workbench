type Props = {
  route: { taskType: string; modelId: string; reason: string } | null;
  state: string | null;
};

export default function RouteBadge({ route, state }: Props) {
  if (!route) return null;
  const isRunning = state === "running" || state === "acting" || state === "planning";
  return (
    <div className="mx-4 mt-2 px-3.5 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] flex items-center gap-3 text-sm text-[var(--text-secondary)]">
      <span className={`flex items-center gap-2 font-medium ${isRunning ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
        <span>Model</span>
      </span>
      <span className="font-mono text-xs text-[var(--text-tertiary)]">{route.modelId}</span>
      <span className="text-xs text-[var(--text-tertiary)] hidden sm:inline">Reason: {route.reason}</span>
      {state && <span className="ml-auto font-mono text-xs text-[var(--text-tertiary)]">{state}</span>}
    </div>
  );
}
