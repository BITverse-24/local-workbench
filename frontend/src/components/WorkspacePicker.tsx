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
          className="w-full group flex items-center justify-center gap-2 px-3 py-2 rounded-xl neu-button text-xs font-medium transition-all hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
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
            className="text-amber-400/80 group-hover:text-amber-300 transition-colors"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="opacity-90">{loading ? 'Opening...' : 'Open Project Folder'}</span>
        </button>
      </div>
    );
  }

  const folderName = getFolderName(workspace.root);

  return (
    <div className="w-full p-2.5 rounded-xl neu-card border border-white/[0.08] flex flex-col gap-2 animate-apple-fade">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1" title={workspace.root}>
          <div className="w-6 h-6 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-amber-300"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-white/90 truncate leading-tight">
              {folderName}
            </div>
            <div className="text-[10px] text-white/40 truncate leading-tight font-mono">
              {workspace.root}
            </div>
          </div>
        </div>

        <button
          onClick={onCloseWorkspace}
          className="w-5 h-5 rounded-full hover:bg-white/10 flex items-center justify-center text-white/40 hover:text-white/80 transition-colors shrink-0"
          title="Close workspace"
          aria-label="Close workspace"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-white/[0.05] text-[10px]">
        <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Workspace Active
        </span>
        <button
          onClick={onPickWorkspace}
          className="text-white/50 hover:text-white/80 transition-colors underline decoration-white/20 hover:decoration-white/60"
        >
          Change
        </button>
      </div>
    </div>
  );
}
