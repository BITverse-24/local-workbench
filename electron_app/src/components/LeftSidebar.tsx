import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  collapsed: boolean;
  onCollapse: () => void;
};

type Chat = {
  id: string;
  title: string;
  pinned?: boolean;
};

const DEFAULT_CHATS: Chat[] = [
  { id: '1', title: 'What is the capital of France?' },
  { id: '2', title: 'Write a Python script for CSV parsing…' },
  { id: '3', title: 'Explain quantum computing' },
  { id: '4', title: 'Inspection report → approval note' },
];

function DotsIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="5" cy="12" r="2" />
    </svg>
  );
}

export default function LeftSidebar({ collapsed, onCollapse }: Props) {
  const [chats, setChats] = useState<Chat[]>(DEFAULT_CHATS);
  const [selectedId, setSelectedId] = useState<string>('1');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
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
    if (v) setChats((prev) => prev.map((c) => (c.id === editingId ? { ...c, title: v } : c)));
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    setChats((prev) => prev.filter((c) => c.id !== id));
    setOpenMenuId(null);
    if (selectedId === id) setSelectedId(chats.find((c) => c.id !== id)?.id ?? '');
  };

  const handlePinToggle = (id: string) => {
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
    setOpenMenuId(null);
  };

  const handleNewChat = () => {
    const id = Date.now().toString();
    const base = 'New chat';
    const count = chats.filter((c) => c.title.startsWith(base)).length;
    const title = count === 0 ? base : `${base} ${count + 1}`;
    const newChat: Chat = { id, title };
    setChats((prev) => [newChat, ...prev]);
    setSelectedId(id);
    setEditingId(id);
    setEditValue(title);
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
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="text-[11px] font-semibold tracking-[0.16em] uppercase opacity-50 whitespace-nowrap">History</div>
        <div className="flex items-center gap-1.5">
          <button onClick={onCollapse} className="w-7 h-7 rounded-full neu-button grid place-items-center text-xs shrink-0" title="Collapse">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <button onClick={handleNewChat} className="w-7 h-7 rounded-full neu-button grid place-items-center text-sm shrink-0" title="New chat" aria-label="New chat">＋</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 mt-1 pr-1">
        {(() => {
          const sortedChats = [...chats].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
          return sortedChats.map((chat, idx) => {
          const isSelected = selectedId === chat.id;
          const isEditing = editingId === chat.id;
          const isMenuOpen = openMenuId === chat.id;
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
                  onClick={() => setSelectedId(chat.id)}
                  className="flex-1 min-w-0 text-left px-3 py-3 truncate flex items-center gap-1.5"
                  title={chat.title}
                >
                  {chat.pinned && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-60" aria-hidden="true"><path d="M12 17v5" /><path d="M9 20h6" /><path d="M12 3a4 4 0 0 0-4 4v5.5a1 1 0 0 0 .3.7l1.7 1.7a1 1 0 0 0 .7.3h2.6a1 1 0 0 0 .7-.3l1.7-1.7a1 1 0 0 0 .3-.7V7a4 4 0 0 0-4-4z" /></svg>
                  )}
                  <span className={`${isSelected ? 'font-medium leading-tight' : 'opacity-80'} block truncate`}>{chat.title}</span>
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
      {openMenuId && menuPos && (() => {
        const activeChat = chats.find((c) => c.id === openMenuId);
        const isPinned = !!activeChat?.pinned;
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
    </aside>
  );
}
