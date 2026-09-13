import { useState } from 'react';
import FileTree from '../FileTree';

type Props = {
  workspace: WorkspaceInfo | null;
  workspaceTree: HarnessDirEntry[];
  onPickWorkspace?: () => void;
  onCloseWorkspace?: () => void;
  onRefreshTree?: () => void;
  onSelectWorkspaceFile?: (path: string) => void;
  loading?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
};

export default function FilesPanel({
  workspace,
  workspaceTree,
  onPickWorkspace,
  onCloseWorkspace,
  onRefreshTree,
  onSelectWorkspaceFile,
  loading = false,
  isExpanded = true,
  onToggleExpand,
}: Props) {
  const [filterQuery, setFilterQuery] = useState('');

  const getFolderName = (fullPath: string) => {
    const parts = fullPath.replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || fullPath;
  };

  const fileCount = workspaceTree.filter((e) => e.type === 'file').length;

  const filteredTree = filterQuery
    ? workspaceTree.filter((e) =>
        e.name.toLowerCase().includes(filterQuery.toLowerCase())
      )
    : workspaceTree;

  return (
    <div
      className={`flex flex-col transition-all duration-200 overflow-hidden ${
        isExpanded ? 'flex-1 min-h-0' : 'shrink-0'
      }`}
    >
      {/* Section Header */}
      <div className="flex items-center justify-between py-1.5 px-1 shrink-0 select-none">
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1.5 text-left group hover:opacity-100 transition-opacity"
          title={isExpanded ? 'Collapse files' : 'Expand files'}
        >
          <span
            className={`text-[11px] text-white/40 group-hover:text-white/80 transition-transform duration-200 ${
              isExpanded ? 'rotate-0' : '-rotate-90'
            }`}
          >
            ▾
          </span>
          <div className="flex items-center gap-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[var(--text-tertiary)]"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="text-sm font-semibold text-[var(--text-secondary)] tracking-normal group-hover:text-[var(--text-primary)] transition-colors">
              Files
            </span>
            {workspace && (
              <span className="text-xs px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] font-mono">
                {fileCount}
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-1">
          {workspace ? (
            <>
              {onRefreshTree && (
                <button
                  onClick={onRefreshTree}
                  disabled={loading}
                  className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                  title="Refresh files"
                  aria-label="Refresh files"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={loading ? 'animate-spin text-[var(--accent)]' : ''}
                  >
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                  </svg>
                </button>
              )}

              {onCloseWorkspace && (
                <button
                  onClick={onCloseWorkspace}
                  className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-[var(--text-secondary)] hover:text-[var(--status-error)] transition-colors"
                  title="Disconnect workspace"
                  aria-label="Disconnect workspace"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>

      {/* Expanded Content Area */}
      {isExpanded && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden pt-1">
          {workspace ? (
            <>
              {/* Compact Workspace Status Bar */}
              <div className="flex items-start justify-between px-2.5 py-2 mb-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)] text-xs shrink-0 border border-[var(--border-subtle)] gap-2">
                <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-success)] shrink-0" />
                    <span className="font-medium text-[var(--text-primary)] truncate" title={getFolderName(workspace.root)}>
                      {getFolderName(workspace.root)}
                    </span>
                  </div>
                  <span className="text-[var(--text-tertiary)] truncate font-mono text-[10px] pl-3" title={workspace.root}>
                    {workspace.root}
                  </span>
                </div>
                {onPickWorkspace && (
                  <button
                    onClick={onPickWorkspace}
                    className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] underline shrink-0 font-medium pt-0.5"
                  >
                    Change
                  </button>
                )}
              </div>

              {/* Quick file search if > 8 files */}
              {workspaceTree.length > 8 && (
                <div className="relative flex items-center mb-2 px-0.5 shrink-0">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="absolute left-3 text-white/30 pointer-events-none"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    placeholder="Search files..."
                    className="w-full bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] pl-7 pr-7 py-1.5 text-xs sm:text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--border-strong)] transition-colors"
                  />
                  {filterQuery && (
                    <button
                      onClick={() => setFilterQuery('')}
                      className="absolute right-2 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] w-4 h-4 rounded-[var(--radius-sm)] grid place-items-center"
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}

              {/* File Tree */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                <FileTree
                  entries={filteredTree}
                  onSelectFile={onSelectWorkspaceFile}
                  onRefresh={onRefreshTree}
                  loading={loading}
                />
              </div>
            </>
          ) : (
            <div className="p-3.5 text-center rounded-[var(--radius-md)] neu-pressed opacity-60 space-y-1.5 my-auto">
              <div className="text-base">📁</div>
              <div className="text-xs font-medium text-white/80">No folder connected</div>
              <p className="text-xs text-white/40 leading-snug">
                Open a local project directory to inspect source code and execute harness tools.
              </p>
              <button
                onClick={onPickWorkspace}
                disabled={loading}
                className="mt-1 px-3.5 py-1.5 rounded-full neu-button text-xs font-medium text-amber-300 inline-flex items-center gap-1.5 hover:border-amber-500/40"
              >
                <span>＋</span>
                <span>Open Folder</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
