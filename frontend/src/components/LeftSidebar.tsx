import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { formatRelativeTime } from '../lib/time';
import WorkspacePicker from './WorkspacePicker';
import FileTree from './FileTree';

export type SidebarChat = {
  id: string;
  title: string;
  /** Backend ISO-8601 updated_at; local entries use creation time. */
  updated_at: string;
};

type Props = {
  collapsed: boolean;
  onCollapse: () => void;
  /** Persisted history (backend `getChatHistory`, newest first). Empty when unreachable. */
  chats: SidebarChat[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /** Rename is local-only until the backend adds a rename channel (see backend/PROPOSALS.md P-B1). */
  onRename: (id: string, title: string) => void;
  /** Archive in backend (soft-delete); parent drops it from the list. */
  onDeleteChat: (id: string) => void;
  workspace?: WorkspaceInfo | null;
  workspaceTree?: HarnessDirEntry[];
  onPickWorkspace?: () => void;
  onCloseWorkspace?: () => void;
  onRefreshTree?: () => void;
  onSelectWorkspaceFile?: (path: string) => void;
  workspaceLoading?: boolean;
};

function DotsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="5" cy="12" r="2" />
    </svg>
  );
}

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
  const [sidebarTab, setSidebarTab] = useState<'chats' | 'files'>('chats');
  // Local-only UI state: pin has no backend column. Rename edits flow up via onRename
  // (persisted through workbench:renameChat) so the chat-box header updates too.
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const updateMenuPos = useCallback(() => {
    if (!openMenuId) return;
    const el = triggerRefs.current.get(openMenuId);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const menuWidth = 160;
    const gap = 6;
    let left = rect.right - menuWidth;
    let top = rect.bottom + gap;
    // keep inside viewport with 8px margin
    const margin = 8;
    if (left < margin) left = margin;
    if (left + menuWidth > window.innerWidth - margin) left = window.innerWidth - menuWidth - margin;
    // flip above if would overflow bottom (3 items: pin/rename/delete)
    const menuHeight = 110;
    if (top + menuHeight > window.innerHeight - margin) {
      top = rect.top - menuHeight - gap;
    }
    if (top < margin) top = margin;
    setMenuPos({ top, left });
  }, [openMenuId]);

  useEffect(() => {
    if (!openMenuId) {
      setMenuPos(null);
      return;
    }
    updateMenuPos();
    window.addEventListener('resize', updateMenuPos);
    window.addEventListener('scroll', updateMenuPos, true);
    return () => {
      window.removeEventListener('resize', updateMenuPos);
      window.removeEventListener('scroll', updateMenuPos, true);
    };
  }, [openMenuId, updateMenuPos]);

  useEffect(() => {
    if (!openMenuId) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (menuRef.current && menuRef.current.contains(target)) return;
      if (target.closest('[data-chat-menu-trigger]')) return;
      setOpenMenuId(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenuId]);

  // Escape dismisses the delete confirmation.
  useEffect(() => {
    if (!confirmDeleteId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setConfirmDeleteId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirmDeleteId]);

  const handleRename = (id: string) => {
    const chat = chats.find((c) => c.id === id);
    if (!chat) return;
    setEditValue(chat.title);
    setEditingId(id);
    setOpenMenuId(null);
  };

  const commitRename = () => {
    if (!editingId) return;
    const v = editValue.trim();
    if (v) onRename(editingId, v);
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    setOpenMenuId(null);
    setConfirmDeleteId(id);
  };

  const confirmDelete = () => {
    if (confirmDeleteId) onDeleteChat(confirmDeleteId);
    setConfirmDeleteId(null);
  };

  const handlePinToggle = (id: string) => {
    setPinned((prev) => ({ ...prev, [id]: !prev[id] }));
    setOpenMenuId(null);
  };

  return (
    <aside
      className={`hidden md:flex flex-col neu-panel flex-shrink-0 overflow-hidden ${!collapsed ? 'animate-apple-left' : ''}`}
      style={{
        width: collapsed ? 0 : 280,
        minWidth: collapsed ? 0 : 280,
        opacity: collapsed ? 0 : 1,
        transform: collapsed ? 'translateX(-12px) scale(0.98)' : 'translateX(0) scale(1)',
        padding: collapsed ? 0 : '16px',
        borderWidth: collapsed ? 0 : '1px',
        pointerEvents: collapsed ? 'none' : 'auto',
        transition: 'width 0.6s cubic-bezier(0.16,1,0.3,1), opacity 0.45s cubic-bezier(0.16,1,0.3,1), transform 0.6s cubic-bezier(0.16,1,0.3,1), padding 0.5s cubic-bezier(0.16,1,0.3,1), border-width 0.4s',
        willChange: 'width, transform, opacity',
      } as React.CSSProperties}
    >
      {/* Workspace Section */}
      <div className="mb-3 shrink-0">
        <WorkspacePicker
          workspace={workspace ?? null}
          onPickWorkspace={onPickWorkspace ?? (() => {})}
          onCloseWorkspace={onCloseWorkspace ?? (() => {})}
          loading={workspaceLoading}
        />
      </div>

      <div className="flex items-center justify-between mb-2 shrink-0">
        <div className="text-[11px] font-semibold tracking-[0.16em] uppercase opacity-50 whitespace-nowrap">
          {workspace ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setSidebarTab('chats')}
                className={`transition-colors ${sidebarTab === 'chats' ? 'text-white opacity-100' : 'opacity-40 hover:opacity-75'}`}
              >
                Chats ({chats.length})
              </button>
              <span className="opacity-30">/</span>
              <button
                onClick={() => setSidebarTab('files')}
                className={`transition-colors ${sidebarTab === 'files' ? 'text-white opacity-100' : 'opacity-40 hover:opacity-75'}`}
              >
                Files ({workspaceTree.filter((e) => e.type === 'file').length})
              </button>
            </div>
          ) : (
            'History'
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={onCollapse} className="w-7 h-7 rounded-full neu-button grid place-items-center text-xs shrink-0" title="Collapse">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button onClick={onNewChat} className="w-7 h-7 rounded-full neu-button grid place-items-center text-sm shrink-0" title="New chat" aria-label="New chat">＋</button>
        </div>
      </div>

      {sidebarTab === 'files' && workspace ? (
        <div className="flex-1 overflow-hidden mt-1">
          <FileTree
            entries={workspaceTree}
            onSelectFile={onSelectWorkspaceFile}
            onRefresh={onRefreshTree}
            loading={workspaceLoading}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-2 mt-1 pr-1">
        {(() => {
          const sortedChats = [...chats].sort((a, b) => Number(!!pinned[b.id]) - Number(!!pinned[a.id]));
          return sortedChats.map((chat, idx) => {
          const isSelected = activeId === chat.id;
          const isEditing = editingId === chat.id;
          const isMenuOpen = openMenuId === chat.id;
          const isPinned = !!pinned[chat.id];
          return (
            <div
              key={chat.id}
              className={`group flex items-center gap-1 w-full rounded-2xl text-sm animate-apple-message ${isSelected ? 'neu-pressed' : 'neu-card hover:brightness-110'}`}
              style={{ transition: 'all 0.5s var(--apple-ease)', animationDelay: `${idx * 60}ms` } as React.CSSProperties}
            >
              {isEditing ? (
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  className="flex-1 min-w-0 bg-transparent outline-none px-3 py-3 text-sm font-medium"
                />
              ) : (
                <button
                  onClick={() => onSelect(chat.id)}
                  className="flex-1 min-w-0 text-left px-3 py-2.5 truncate flex flex-col items-start gap-0.5"
                  title={chat.title}
                >
                  <span className="flex items-center gap-1.5 min-w-0 w-full">
                    {isPinned && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60" aria-hidden="true"><path d="M12 17v5" /><path d="M9 20h6" /><path d="M12 3a4 4 0 0 0-4 4v5.5a1 1 0 0 0 .3.7l1.7 1.7a1 1 0 0 0 .7.3h2.6a1 1 0 0 0 .7-.3l1.7-1.7a1 1 0 0 0 .3-.7V7a4 4 0 0 0-4-4z" /></svg>
                      )}
                    <span className={`${isSelected ? 'font-medium leading-tight' : 'opacity-80'} block truncate`}>{chat.title}</span>
                  </span>
                  <span className="text-[10px] leading-tight opacity-40">{formatRelativeTime(chat.updated_at)}</span>
                </button>
              )}

              {!isEditing && (
                <button
                  ref={(el) => {
                    if (el) triggerRefs.current.set(chat.id, el);
                    else triggerRefs.current.delete(chat.id);
                  }}
                  data-chat-menu-trigger
                  aria-label="Chat options"
                  aria-haspopup="menu"
                  aria-expanded={isMenuOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId(isMenuOpen ? null : chat.id);
                  }}
                  className={`shrink-0 w-7 h-7 mr-1.5 rounded-full grid place-items-center transition-all duration-200
                    ${isMenuOpen ? 'opacity-100 bg-white/10' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-white/10'}
                    focus:opacity-100 focus-visible:opacity-100`}
                  title="More options"
                >
                  <DotsIcon size={14} />
                </button>
              )}
            </div>
          );
        });
        })()}
        {chats.length === 0 && (
          <div className="text-xs opacity-40 text-center py-6">No chats yet</div>
        )}
      </div>
      )}
      {openMenuId && menuPos && (() => {
        const isPinned = !!pinned[openMenuId];
        return createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed w-40 neu-dropdown py-1.5 z-[9999] overflow-hidden"
          style={{ top: menuPos.top, left: menuPos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => handlePinToggle(openMenuId)}
            className="w-full text-left px-3 py-2 text-xs hover:bg-white/[0.06] transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 17v5" /><path d="M9 20h6" /><path d="M12 3a4 4 0 0 0-4 4v5.5a1 1 0 0 0 .3.7l1.7 1.7a1 1 0 0 0 .7.3h2.6a1 1 0 0 0 .7-.3l1.7-1.7a1 1 0 0 0 .3-.7V7a4 4 0 0 0-4-4z" /></svg>
            {isPinned ? 'Unpin' : 'Pin'}
          </button>
          <button
            role="menuitem"
            onClick={() => handleRename(openMenuId)}
            className="w-full text-left px-3 py-2 text-xs hover:bg-white/[0.06] transition-colors flex items-center gap-2"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
            Rename
          </button>
          <button
            role="menuitem"
            onClick={() => handleDelete(openMenuId)}
            className="w-full text-left px-3 py-2 text-xs hover:bg-white/[0.06] transition-colors flex items-center gap-2 text-red-300 hover:text-red-200"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
            Delete
          </button>
        </div>,
        document.body
      );
      })()}
      {confirmDeleteId && createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-[1px] p-4 animate-apple-fade"
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Delete chat"
            className="w-72 max-w-full neu-dropdown p-5 animate-apple-scaleIn"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold">Delete chat?</h3>
            <p className="text-xs opacity-60 mt-1.5 leading-relaxed truncate">
              &ldquo;{chats.find((c) => c.id === confirmDeleteId)?.title ?? 'this chat'}&rdquo; will be archived.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-4 py-1.5 rounded-full neu-button text-xs font-medium"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-1.5 rounded-full text-xs font-semibold bg-red-500/20 border border-red-500/40 text-red-200 hover:bg-red-500/30 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}
