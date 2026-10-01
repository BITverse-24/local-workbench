import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { formatRelativeTime } from '../../lib/time';

export type SidebarChat = {
  id: string;
  title: string;
  updated_at: string;
};

type Props = {
  chats: SidebarChat[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => void;
  onDeleteChat: (id: string) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  className?: string;
  style?: React.CSSProperties;
};

function DotsIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="5" cy="12" r="2" />
    </svg>
  );
}

export default function ChatsPanel({
  chats,
  activeId,
  onSelect,
  onNewChat,
  onRename,
  onDeleteChat,
  isExpanded = true,
  onToggleExpand,
  className = '',
  style,
}: Props) {
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const updateMenuPos = useCallback(() => {
    if (!openMenuId) return;
    const el = triggerRefs.current.get(openMenuId);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const menuWidth = 160;
    const gap = 4;
    let left = rect.right - menuWidth;
    let top = rect.bottom + gap;
    const margin = 8;
    if (left < margin) left = margin;
    if (left + menuWidth > window.innerWidth - margin) left = window.innerWidth - menuWidth - margin;
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

  // PERF OPTIMIZATION: Memoize filtered and pinned-sorted conversation list computations.
  // Prevents re-executing array filtering and sorting on every minor UI re-render.
  const filteredChats = useMemo(
    () =>
      chats.filter((c) =>
        searchQuery ? c.title.toLowerCase().includes(searchQuery.toLowerCase()) : true
      ),
    [chats, searchQuery]
  );

  const sortedChats = useMemo(
    () =>
      [...filteredChats].sort(
        (a, b) => Number(!!pinned[b.id]) - Number(!!pinned[a.id])
      ),
    [filteredChats, pinned]
  );

  return (
    <div
      className={`flex flex-col transition-all duration-200 overflow-hidden ${
        isExpanded ? (className || 'flex-1 min-h-0') : 'shrink-0'
      }`}
      style={isExpanded ? style : undefined}
    >
      {/* Section Header */}
      <div className="flex items-center justify-between py-1.5 px-1 shrink-0 select-none">
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1.5 text-left group hover:opacity-100 transition-opacity"
          title={isExpanded ? 'Collapse chats' : 'Expand chats'}
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
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span className="text-sm font-semibold text-[var(--text-secondary)] tracking-normal group-hover:text-[var(--text-primary)] transition-colors">
              Chats
            </span>
            <span className="text-xs px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] font-mono">
              {chats.length}
            </span>
          </div>
        </button>

        <button
          onClick={onNewChat}
          className="h-7.5 px-3 rounded-[var(--radius-sm)] neu-button text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1.5 transition-colors"
          title="New conversation"
        >
          <span>＋</span>
          <span>New</span>
        </button>
      </div>

      {/* Expanded Content Area */}
      {isExpanded && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden pt-1">
          {/* Quick Search filter if more than 5 chats */}
          {chats.length > 5 && (
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
                className="absolute left-3 text-[var(--text-tertiary)] pointer-events-none"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter chats…"
                className="w-full bg-[var(--bg-canvas)] border border-[var(--border-subtle)] rounded-[var(--radius-sm)] pl-7 pr-7 py-1.5 text-xs sm:text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--border-default)] transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] w-4 h-4 rounded-[var(--radius-sm)] grid place-items-center"
                >
                  ✕
                </button>
              )}
            </div>
          )}

          {/* Scrollable list */}
          <div className="flex-1 overflow-y-auto space-y-1 pr-0.5">
            {sortedChats.length > 0 ? (
              sortedChats.map((chat) => {
                const isSelected = activeId === chat.id;
                const isEditing = editingId === chat.id;
                const isMenuOpen = openMenuId === chat.id;
                const isPinned = !!pinned[chat.id];

                return (
                  <div
                    key={chat.id}
                    className={`group flex items-center gap-1 w-full rounded-[var(--radius-sm)] text-sm transition-colors duration-150 ${
                      isSelected
                        ? 'bg-[var(--accent-muted)] border border-[var(--accent)]/30 text-[var(--text-primary)]'
                        : 'hover:bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] border border-transparent'
                    }`}
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
                        className="flex-1 min-w-0 bg-transparent outline-none px-3 py-2 text-sm font-medium text-[var(--text-primary)]"
                      />
                    ) : (
                      <button
                        onClick={() => onSelect(chat.id)}
                        className="flex-1 min-w-0 text-left px-3 py-2 truncate flex flex-col items-start"
                        title={chat.title}
                      >
                        <span className="flex items-center gap-2 min-w-0 w-full">
                          {isPinned ? (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="shrink-0 text-[var(--text-secondary)]"
                              aria-hidden="true"
                            >
                              <path d="M12 17v5" />
                              <path d="M9 20h6" />
                              <path d="M12 3a4 4 0 0 0-4 4v5.5a1 1 0 0 0 .3.7l1.7 1.7a1 1 0 0 0 .7.3h2.6a1 1 0 0 0 .7-.3l1.7-1.7a1 1 0 0 0 .3-.7V7a4 4 0 0 0-4-4z" />
                            </svg>
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-tertiary)] shrink-0" />
                          )}
                          <span
                            className={`truncate ${
                              isSelected ? 'font-medium text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
                            }`}
                          >
                            {chat.title}
                          </span>
                        </span>
                        <span className="text-xs leading-tight text-[var(--text-tertiary)] ml-3.5 font-mono mt-0.5">
                          {formatRelativeTime(chat.updated_at)}
                        </span>
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
                        className={`shrink-0 w-7 h-7 mr-1.5 rounded-[var(--radius-sm)] grid place-items-center transition-all duration-150 ${
                          isMenuOpen
                            ? 'opacity-100 bg-white/15'
                            : 'opacity-0 group-hover:opacity-100 hover:bg-white/10'
                        }`}
                        title="Options"
                      >
                        <DotsIcon size={14} />
                      </button>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="p-3.5 text-center rounded-[var(--radius-md)] neu-pressed opacity-60 space-y-1">
                <div className="text-xs text-[var(--text-secondary)]">
                  {searchQuery ? 'No matching chats' : 'No conversation history'}
                </div>
                {!searchQuery && (
                  <button
                    onClick={onNewChat}
                    className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] underline mt-1"
                  >
                    Start a new conversation
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Options Menu Portal */}
      {openMenuId && menuPos && (() => {
        const isPinned = !!pinned[openMenuId];
        return createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed w-36 neu-dropdown py-1 z-[9999] overflow-hidden"
            style={{ top: menuPos.top, left: menuPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              role="menuitem"
              onClick={() => handlePinToggle(openMenuId)}
              className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-white/[0.06] transition-colors flex items-center gap-2"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 17v5" />
                <path d="M9 20h6" />
                <path d="M12 3a4 4 0 0 0-4 4v5.5a1 1 0 0 0 .3.7l1.7 1.7a1 1 0 0 0 .7.3h2.6a1 1 0 0 0 .7-.3l1.7-1.7a1 1 0 0 0 .3-.7V7a4 4 0 0 0-4-4z" />
              </svg>
              {isPinned ? 'Unpin' : 'Pin'}
            </button>
            <button
              role="menuitem"
              onClick={() => handleRename(openMenuId)}
              className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-white/[0.06] transition-colors flex items-center gap-2"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Rename
            </button>
            <button
              role="menuitem"
              onClick={() => handleDelete(openMenuId)}
              className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-white/[0.06] transition-colors flex items-center gap-2 text-red-300 hover:text-red-200"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              </svg>
              Archive
            </button>
          </div>,
          document.body
        );
      })()}

      {/* Delete Confirmation Alert */}
      {confirmDeleteId && createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Archive chat"
            className="w-72 max-w-full rounded-[var(--radius-md)] neu-panel border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Archive chat?</h3>
            <p className="text-xs text-[var(--text-secondary)] mt-1.5 leading-relaxed truncate">
              &ldquo;{chats.find((c) => c.id === confirmDeleteId)?.title ?? 'this chat'}&rdquo; will be archived.
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-3 py-1 rounded-[var(--radius-sm)] neu-button text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-3 py-1 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--status-error)]/15 border border-[var(--status-error)]/30 text-[var(--status-error)] hover:bg-[var(--status-error)]/25 transition-colors"
              >
                Archive
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
