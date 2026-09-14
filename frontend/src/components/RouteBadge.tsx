type Props = {
  route: { taskType: string; modelId: string; reason: string } | null;
  state: string | null;
};

function getRoleIcon(taskType: string) {
  switch (taskType.toLowerCase()) {
    case 'vision':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
        </svg>
      );
    case 'code':
    case 'coding':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case 'draft':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      );
    case 'plan':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
      );
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
  }
}

export default function RouteBadge({ route, state }: Props) {
  if (!route) return null;
  const isRunning = state === "running" || state === "acting" || state === "planning";
  return (
    <div className="mx-4 mt-2 px-3.5 py-2 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] flex items-center gap-3 text-sm text-[var(--text-secondary)]">
      <span className={`flex items-center gap-2 font-medium ${isRunning ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
        <span className="shrink-0">{getRoleIcon(route.taskType)}</span>
        <span>{route.taskType} route</span>
      </span>
      <span className="font-mono text-xs text-[var(--text-tertiary)]">{route.modelId}</span>
      <span className="text-xs text-[var(--text-tertiary)] hidden sm:inline">Reason: {route.reason}</span>
      {state && <span className="ml-auto font-mono text-xs text-[var(--text-tertiary)]">{state}</span>}
    </div>
  );
}
