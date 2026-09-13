type Props = {
  workspace: WorkspaceInfo | null;
  onPickWorkspace: () => void;
  onCloseWorkspace: () => void;
  loading?: boolean;
};

export default function WorkspacePicker({ workspace, onPickWorkspace, onCloseWorkspace, loading = false }: Props) {
  const getFolderName = (fullPath: string) => {
    const parts = fullPath.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || fullPath;
  };

  if (!workspace) {
    return (
      <div className="w-full">
        <button
          onClick={onPickWorkspace}
          disabled={loading}
          className="w-full group flex items-center justify-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] neu-button text-xs font-medium transition-colors disabled:opacity-50"
          title="Open a local folder to enable workspace harness tools"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] transition-colors"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">{loading ? 'Opening...' : 'Open project folder'}</span>
        </button>
      </div>
    );
  }

  const folderName = getFolderName(workspace.root);

  return (
    <div className="w-full p-2.5 rounded-[var(--radius-sm)] neu-card border border-[var(--border-subtle)] bg-[var(--bg-surface)] flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1" title={workspace.root}>
          <div className="w-6 h-6 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] flex items-center justify-center shrink-0">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[var(--text-secondary)]"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-[var(--text-primary)] truncate leading-tight">
              {folderName}
            </div>
            <div className="text-[10px] text-[var(--text-tertiary)] truncate leading-tight font-mono">
              {workspace.root}
            </div>
          </div>
        </div>

        <button
          onClick={onCloseWorkspace}
          className="w-5 h-5 rounded-[var(--radius-sm)] neu-button flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors shrink-0"
          title="Close workspace"
          aria-label="Close workspace"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-[var(--border-subtle)] text-[10px]">
        <span className="flex items-center gap-1.5 text-[var(--status-success)] font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-success)]" />
          Workspace active
        </span>
        <button
          onClick={onPickWorkspace}
          className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors underline decoration-[var(--border-subtle)] hover:decoration-[var(--border-muted)]"
        >
          Change
        </button>
      </div>
    </div>
  );
}
