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
      <div className="flex items-center justify-between py-1 px-1 shrink-0 select-none">
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1.5 text-left group hover:opacity-100 transition-opacity"
          title={isExpanded ? 'Collapse files' : 'Expand files'}
        >
          <span
            className={`text-[10px] text-white/40 group-hover:text-white/80 transition-transform duration-200 ${
              isExpanded ? 'rotate-0' : '-rotate-90'
            }`}
          >
            ▾
          </span>
          <div className="flex items-center gap-1.5">
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
            <span className="text-[11px] font-semibold uppercase tracking-wider text-white/70 group-hover:text-white transition-colors">
              Files
            </span>
            {workspace && (
              <span className="text-[9px] px-1.5 py-0.2 rounded-full neu-pressed text-amber-300/80 font-mono">
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
                  className="p-1 rounded-full neu-button text-white/50 hover:text-white transition-colors"
                  title="Refresh files"
                  aria-label="Refresh files"
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={loading ? 'animate-spin text-amber-400' : ''}
                  >
                    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                  </svg>
                </button>
              )}

              {onCloseWorkspace && (
                <button
                  onClick={onCloseWorkspace}
                  className="p-1 rounded-full neu-button text-white/40 hover:text-red-300 transition-colors"
                  title="Disconnect workspace"
                  aria-label="Disconnect workspace"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </>
          ) : (
            <button
              onClick={onPickWorkspace}
              disabled={loading}
              className="px-2 py-0.5 rounded-full neu-button text-[11px] font-medium text-amber-300/80 hover:text-amber-200 flex items-center gap-1 hover:border-amber-500/30 transition-colors"
              title="Open project folder"
            >
              <span>＋</span>
              <span>Open</span>
            </button>
          )}
        </div>
      </div>

      {/* Expanded Content Area */}
      {isExpanded && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden pt-1">
          {workspace ? (
            <>
              {/* Compact Workspace Status Bar */}
              <div className="flex items-center justify-between px-2 py-1 mb-1 rounded-lg neu-pressed bg-[#181818] text-[10px] shrink-0 border border-white/[0.04]">
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                  <span className="font-semibold text-white/90 truncate">
                    {getFolderName(workspace.root)}
                  </span>
                  <span className="text-white/30 truncate font-mono text-[9px]" title={workspace.root}>
                    ({workspace.root})
                  </span>
                </div>
                {onPickWorkspace && (
                  <button
                    onClick={onPickWorkspace}
                    className="text-[9px] text-white/40 hover:text-white/80 ml-1 underline shrink-0"
                  >
                    Change
                  </button>
                )}
              </div>

              {/* Quick file search if > 8 files */}
              {workspaceTree.length > 8 && (
                <div className="relative flex items-center mb-1.5 px-0.5 shrink-0">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="absolute left-2.5 text-white/30 pointer-events-none"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    placeholder="Search files..."
                    className="w-full bg-[#181818] border border-white/[0.06] rounded-lg pl-6 pr-6 py-1 text-[11px] text-white/80 placeholder:text-white/30 outline-none focus:border-white/20 transition-colors"
                  />
                  {filterQuery && (
                    <button
                      onClick={() => setFilterQuery('')}
                      className="absolute right-2 text-[9px] text-white/40 hover:text-white/80 w-3.5 h-3.5 rounded-full grid place-items-center"
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
            <div className="p-3 text-center rounded-xl neu-pressed opacity-50 space-y-1.5 my-auto">
              <div className="text-sm">📁</div>
              <div className="text-[11px] font-medium text-white/80">No folder connected</div>
              <p className="text-[10px] text-white/40 leading-snug">
                Open a local project directory to inspect source code and execute harness tools.
              </p>
              <button
                onClick={onPickWorkspace}
                disabled={loading}
                className="mt-1 px-3 py-1 rounded-full neu-button text-[11px] text-amber-300 inline-flex items-center gap-1 hover:border-amber-500/40"
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
