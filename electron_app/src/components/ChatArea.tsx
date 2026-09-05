import { useRef, useEffect, useState, useCallback } from 'react';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  files?: File[];
};

type Props = {
  messages?: ChatMessage[];
  onEditMessage?: (id: string, newText: string) => void;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileLabel(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['pdf'].includes(ext)) return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'DOC';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'SHEET';
  if (['ppt', 'pptx'].includes(ext)) return 'SLIDES';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'heic'].includes(ext)) return 'IMAGE';
  return ext ? ext.toUpperCase() : 'FILE';
}

export default function ChatArea({ messages = [], onEditMessage }: Props) {
  const hasMessages = messages.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const anchor = bottomRef.current;
    if (anchor) {
      anchor.scrollIntoView({ behavior, block: 'end' });
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 120;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom < threshold;
    setAutoScroll(isNearBottom);
    setShowJump(!isNearBottom && hasMessages);
  }, [hasMessages]);

  // Auto scroll on new messages if user is near bottom
  useEffect(() => {
    if (autoScroll) {
      scrollToBottom('smooth');
    }
  }, [messages, autoScroll, scrollToBottom]);

  // Initial scroll to bottom on mount
  useEffect(() => {
    scrollToBottom('instant' as ScrollBehavior);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep pinned during content resize (streaming, images)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (autoScroll) scrollToBottom('smooth');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoScroll, scrollToBottom]);

  const handleCopy = useCallback(async (msg: ChatMessage) => {
    try {
      const text = msg.text ?? '';
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedId(msg.id);
      window.setTimeout(() => setCopiedId((prev) => (prev === msg.id ? null : prev)), 1500);
    } catch {
      // ignore
    }
  }, []);

  const handleEditStart = useCallback((msg: ChatMessage) => {
    setEditingId(msg.id);
    setEditDraft(msg.text);
  }, []);

  const handleEditCancel = useCallback(() => {
    setEditingId(null);
    setEditDraft('');
  }, []);

  const handleEditSave = useCallback(() => {
    if (!editingId) return;
    const trimmed = editDraft.trim();
    // allow empty? keep original if empty and no files? We'll allow empty only if we keep original; prevent saving empty whitespace
    if (trimmed.length === 0) return;
    if (onEditMessage) {
      onEditMessage(editingId, editDraft);
    }
    setEditingId(null);
    setEditDraft('');
  }, [editingId, editDraft, onEditMessage]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative" style={{ background: '#1A1A1A' }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5"
      >
        {!hasMessages ? (
          <>
            <div className="flex justify-end animate-apple-message">
              <div className="px-5 py-3.5 rounded-[18px] rounded-br-[6px] max-w-[88%] md:max-w-[72%] neu-raised">
                <p className="text-sm leading-relaxed">Hello, how are you?</p>
              </div>
            </div>
            <div className="flex justify-start animate-apple-message delay-100">
              <div className="px-5 py-3.5 rounded-[18px] rounded-bl-[6px] max-w-[88%] md:max-w-[72%] neu-card">
                <p className="text-sm leading-relaxed">I&apos;m doing well, thank you! How can I help you today? I&apos;m running fully air-gapped — no external egress.</p>
                <div className="flex items-center gap-2 mt-3"></div>
              </div>
            </div>
            <div className="flex justify-start animate-apple-message delay-200">
              <div className="w-full max-w-[88%] md:max-w-[78%] rounded-2xl neu-card p-3 flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl neu-pressed grid place-items-center text-xs">◐</div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium">OCR extraction complete</div>
                  <div className="text-xs opacity-50 truncate">5 findings • page-ref validated • ready for retrieval</div>
                </div>
                <span className="text-xs px-3 py-1.5 neu-button-primary font-medium shrink-0">View</span>
              </div>
            </div>
          </>
        ) : null}

        {messages.map((msg) => {
          const isUser = msg.role === 'user';
          const isEditing = editingId === msg.id;
          const isCopied = copiedId === msg.id;

          return (
            <div
              key={msg.id}
              className={`flex animate-apple-message group ${isUser ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`flex flex-col gap-1 ${isUser ? 'items-end max-w-[88%] md:max-w-[72%]' : 'max-w-[88%] md:max-w-[72%] items-start'}`}>
                <div
                  className={`px-5 py-3.5 rounded-[18px] w-full ${isUser ? 'rounded-br-[6px] neu-raised' : 'rounded-bl-[6px] neu-card'}`}
                >
                  {isEditing ? (
                    <div className="flex flex-col gap-2 min-w-[220px]">
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            handleEditCancel();
                          }
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            handleEditSave();
                          }
                        }}
                        autoFocus
                        rows={3}
                        className="w-full min-h-[64px] max-h-[160px] p-3 rounded-xl bg-[#1A1A1A] border border-[#2A2A2A] outline-none text-sm leading-relaxed resize-none focus:border-[#333] focus:ring-1 focus:ring-white/10"
                        placeholder="Edit message..."
                      />
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={handleEditCancel}
                          className="px-3 py-1.5 rounded-full neu-button text-xs font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleEditSave}
                          disabled={editDraft.trim().length === 0}
                          className={`px-4 py-1.5 rounded-full text-xs font-semibold transition ${editDraft.trim().length === 0 ? 'neu-button opacity-40 cursor-not-allowed' : 'neu-button-primary'}`}
                        >
                          Save
                        </button>
                      </div>
                      <div className="text-[10px] opacity-40 text-right">Esc to cancel • Ctrl+Enter to save</div>
                    </div>
                  ) : (
                    <>
                      {msg.text && <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.text}</p>}
                      {msg.files && msg.files.length > 0 && (
                        <div className={`flex flex-wrap gap-2 ${msg.text ? 'mt-3' : ''}`}>
                          {msg.files.map((f, i) => (
                            <span
                              key={`${f.name}-${i}`}
                              className="inline-flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full neu-pressed text-xs max-w-[200px]"
                            >
                              <span className="w-6 h-6 rounded-full bg-white/10 grid place-items-center text-[8px] font-bold shrink-0">{fileLabel(f.name).slice(0, 3)}</span>
                              <span className="truncate font-medium">{f.name}</span>
                              <span className="opacity-50 shrink-0">{formatSize(f.size)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {/* Icons at bottom of text box - outside bubble, bottom-aligned */}
                {isUser && !isEditing && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
                    <button
                      onClick={() => handleCopy(msg)}
                      className="w-7 h-7 grid place-items-center rounded-full neu-pressed hover:brightness-125 border border-transparent hover:border-[#2A2A2A] text-white/70 hover:text-white transition-colors"
                      title={isCopied ? 'Copied!' : 'Copy'}
                      aria-label={isCopied ? 'Copied' : 'Copy message'}
                    >
                      {isCopied ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3.5" />
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={() => handleEditStart(msg)}
                      className="w-7 h-7 grid place-items-center rounded-full neu-pressed hover:brightness-125 border border-transparent hover:border-[#2A2A2A] text-white/70 hover:text-white transition-colors"
                      title="Edit"
                      aria-label="Edit message"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} aria-hidden />
      </div>

      {showJump && (
        <button
          onClick={() => {
            setAutoScroll(true);
            scrollToBottom('smooth');
            setShowJump(false);
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full neu-button shadow-lg text-xs font-medium hover:scale-[1.02] active:scale-[0.98] transition-transform"
          aria-label="Scroll to bottom"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 5v14" />
            <path d="M19 12l-7 7-7-7" />
          </svg>
          Bottom
        </button>
      )}
    </div>
  );
}
