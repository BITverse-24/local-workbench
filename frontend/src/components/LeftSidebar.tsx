import { useState } from 'react';
import ChatsPanel, { type SidebarChat } from './sidebar/ChatsPanel';
import FilesPanel from './sidebar/FilesPanel';
import KnowledgePanel from './sidebar/KnowledgePanel';

export type { SidebarChat };

type Props = {
  collapsed: boolean;
  onCollapse: () => void;
  chats: SidebarChat[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDeleteChat: (id: string) => void;
  workspace?: WorkspaceInfo | null;
  workspaceTree?: HarnessDirEntry[];
  onPickWorkspace?: () => void;
  onCloseWorkspace?: () => void;
  onRefreshTree?: () => void;
  onSelectWorkspaceFile?: (path: string) => void;
  workspaceLoading?: boolean;
};

export default function LeftSidebar({
  collapsed,
  onCollapse,
  chats,
  activeId,
  onSelect,
  onNewChat,
  onDeleteChat,
  onRename,
  workspace = null,
  workspaceTree = [],
  onPickWorkspace,
  onCloseWorkspace,
  onRefreshTree,
  onSelectWorkspaceFile,
  workspaceLoading = false,
}: Props) {
  // Collapsible panel states — all 3 default to expanded (1/3 vertical height each)
  const [chatsOpen, setChatsOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(true);
  const [knowledgeOpen, setKnowledgeOpen] = useState(true);

  return (
    <aside
      className={`hidden md:flex flex-col neu-panel flex-shrink-0 overflow-hidden ${
        !collapsed ? 'animate-apple-left' : ''
      }`}
      style={
        {
          width: collapsed ? 0 : 310,
          minWidth: collapsed ? 0 : 310,
          opacity: collapsed ? 0 : 1,
          transform: collapsed ? 'translateX(-12px) scale(0.98)' : 'translateX(0) scale(1)',
          padding: collapsed ? 0 : '12px 10px',
          borderWidth: collapsed ? 0 : '1px',
          pointerEvents: collapsed ? 'none' : 'auto',
          transition:
            'width 0.55s cubic-bezier(0.16,1,0.3,1), opacity 0.4s cubic-bezier(0.16,1,0.3,1), transform 0.55s cubic-bezier(0.16,1,0.3,1), padding 0.45s cubic-bezier(0.16,1,0.3,1), border-width 0.3s',
          willChange: 'width, transform, opacity',
        } as React.CSSProperties
      }
    >
      {/* Top Header */}
      <div className="flex items-center justify-between pb-2.5 mb-1.5 px-1 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] flex items-center justify-center text-xs font-semibold text-[var(--text-secondary)]">
            S
          </div>
          <span className="text-sm font-semibold text-[var(--text-primary)] tracking-normal">
            Explorer
          </span>
        </div>

        <button
          onClick={onCollapse}
          className="w-8 h-8 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      {/* 3-Tier Vertical Panels: Upper 1/3 (Chats), Middle 1/3 (Files), Lower 1/3 (Knowledge) */}
      <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-hidden">
        {/* Upper 1/3: Conversations / Chats */}
        <ChatsPanel
          chats={chats}
          activeId={activeId}
          onSelect={onSelect}
          onNewChat={onNewChat}
          onRename={onRename}
          onDeleteChat={onDeleteChat}
          isExpanded={chatsOpen}
          onToggleExpand={() => setChatsOpen((p) => !p)}
        />

        {/* Section Divider */}
        <div className="h-[1px] bg-white/[0.06] shrink-0 mx-0.5" />

        {/* Middle 1/3: Workspace Files */}
        <FilesPanel
          workspace={workspace}
          workspaceTree={workspaceTree}
          onPickWorkspace={onPickWorkspace}
          onCloseWorkspace={onCloseWorkspace}
          onRefreshTree={onRefreshTree}
          onSelectWorkspaceFile={onSelectWorkspaceFile}
          loading={workspaceLoading}
          isExpanded={filesOpen}
          onToggleExpand={() => setFilesOpen((p) => !p)}
        />

        {/* Section Divider */}
        <div className="h-[1px] bg-white/[0.06] shrink-0 mx-0.5" />

        {/* Lower 1/3: SOP Knowledge Base */}
        <KnowledgePanel
          isExpanded={knowledgeOpen}
          onToggleExpand={() => setKnowledgeOpen((p) => !p)}
        />
      </div>
    </aside>
  );
}
