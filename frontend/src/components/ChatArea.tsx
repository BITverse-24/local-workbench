import React, { useRef, useEffect, useState, useCallback } from 'react';
import ArtifactCard from './ArtifactCard';
import RunWaitingIndicator from './RunWaitingIndicator';

export type ChatFile = {
  name: string;
  size?: number;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  files?: Array<File | ChatFile>;
  artifacts?: ArtifactRef[];
};

type Props = {
  messages?: ChatMessage[];
  onEditMessage?: (id: string, newText: string) => void;
  onAttachFiles?: (files: File[]) => { added: number; rejected: File[] };
  onSaveArtifact?: (artifact: ArtifactRef) => void;
  isRunning?: boolean;
  runState?: RunState | null;
  activeRoute?: { taskType: string; modelId: string; reason: string } | null;
  runEvents?: RunEvent[];
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

const HIGHLIGHT_KEYWORDS = new Set([
  'if','else','for','while','return','function','class','const','let','var','import','export','from','as','async','await','try','catch','finally','throw','new','this','super','extends','implements','interface','enum','type','public','private','protected','static','yield','break','continue','switch','case','default','do','in','of','instanceof','typeof','void','delete','true','false','null','undefined','def','elif','except','lambda','with','pass','raise','global','nonlocal','assert','and','or','not','is','print','int','float','str','list','dict','bool','package','struct','func','select','chan','map','defer','goto','include','define','using','namespace','template','typename','virtual','override','final','abstract','throws','synchronized','transient','volatile','native','strictfp','where','order','by','group','having','union','insert','update','create','alter','drop','join','inner','left','right','outer','on','double','char','long','short','byte','boolean','select',
]);

function highlightCode(code: string): React.ReactNode[] {
  const keywords = HIGHLIGHT_KEYWORDS;
  // strings, comments, numbers, keywords
  const pattern = new RegExp(
    '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`|//.*|#.*|/\\*[\\s\\S]*?\\*/|<!--[\\s\\S]*?-->|\\b(?:' + Array.from(keywords).join('|') + ')\\b|\\b\\d+\\.?\\d*\\b)',
    'g'
  );
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = pattern.exec(code)) !== null) {
    if (m.index > lastIndex) nodes.push(code.slice(lastIndex, m.index));
    const token = m[0];
    if (!token) { lastIndex = pattern.lastIndex; continue; }
    if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) {
      nodes.push(<span key={`hl-s-${idx++}`} className="text-emerald-300">{token}</span>);
    } else if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*') || token.startsWith('<!--')) {
      nodes.push(<span key={`hl-c-${idx++}`} className="text-zinc-500 italic">{token}</span>);
    } else if (/^\d/.test(token)) {
      nodes.push(<span key={`hl-n-${idx++}`} className="text-amber-300">{token}</span>);
    } else if (keywords.has(token)) {
      nodes.push(<span key={`hl-k-${idx++}`} className="text-sky-300 font-medium">{token}</span>);
    } else {
      nodes.push(token);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < code.length) nodes.push(code.slice(lastIndex));
  if (nodes.length === 0) return [code];
  return nodes;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`([^`]+?)`|\[(.+?)\]\((.+?)\)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIndex) {
      nodes.push(text.slice(lastIndex, m.index));
    }
    if (m[1]) {
      nodes.push(<strong key={`${keyPrefix}-b-${idx++}`} className="font-semibold text-[var(--text-primary)]">{m[1]}</strong>);
    } else if (m[2]) {
      nodes.push(<strong key={`${keyPrefix}-b2-${idx++}`} className="font-semibold text-[var(--text-primary)]">{m[2]}</strong>);
    } else if (m[3]) {
      nodes.push(<em key={`${keyPrefix}-i-${idx++}`} className="italic">{m[3]}</em>);
    } else if (m[4]) {
      nodes.push(<em key={`${keyPrefix}-i2-${idx++}`} className="italic">{m[4]}</em>);
    } else if (m[5]) {
      nodes.push(<code key={`${keyPrefix}-c-${idx++}`} className="px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-sm font-mono text-[var(--text-primary)]">{m[5]}</code>);
    } else if (m[6] && m[7]) {
      nodes.push(<a key={`${keyPrefix}-a-${idx++}`} href={m[7]} target="_blank" rel="noreferrer" className="underline underline-offset-2 decoration-[var(--border-strong)] hover:text-[var(--accent)] text-[var(--text-primary)] transition-colors">{m[6]}</a>);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  // handle case with no matches
  if (nodes.length === 0) return [text];
  return nodes;
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      const text = code;
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }, [code]);
  return (
    <div className="relative group/code">
      <pre className="p-4 pr-12 rounded-[var(--radius-md)] bg-[var(--bg-canvas)] border border-[var(--border-subtle)] overflow-x-auto text-[13.5px] sm:text-[14px] font-mono leading-relaxed whitespace-pre-wrap break-words text-[var(--text-primary)]">
        <code>{highlightCode(code)}</code>
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2.5 right-2.5 w-7 h-7 grid place-items-center rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors opacity-0 group-hover/code:opacity-100 group-focus-within/code:opacity-100 focus:opacity-100 transition-opacity duration-150 pointer-events-none group-hover/code:pointer-events-auto group-focus-within/code:pointer-events-auto"
        title={copied ? 'Copied' : 'Copy code'}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--status-success)]">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3.5" />
          </svg>
        )}
      </button>
      {lang ? <span className="absolute bottom-2 right-2.5 text-xs font-mono text-[var(--text-tertiary)] pointer-events-none">{lang}</span> : null}
    </div>
  );
}

const BasicMarkdown = React.memo(function BasicMarkdown({ text }: { text: string }) {
  if (!text) return null;
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const segments: Array<{ type: 'text' | 'code'; content: string; lang?: string }> = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIdx) segments.push({ type: 'text', content: text.slice(lastIdx, match.index) });
    segments.push({ type: 'code', content: match[2], lang: match[1] });
    lastIdx = codeBlockRegex.lastIndex;
  }
  if (lastIdx < text.length) segments.push({ type: 'text', content: text.slice(lastIdx) });
  if (segments.length === 0) segments.push({ type: 'text', content: text });

  return (
    <div className="space-y-3">
      {segments.map((seg, si) => {
        if (seg.type === 'code') {
          return <CodeBlock key={`code-${si}`} code={seg.content.replace(/^\n/, '').replace(/\n$/, '')} lang={seg.lang} />;
        }
        const blocks = seg.content.split(/\n{2,}/);
        return blocks.map((block, bi) => {
          const trimmed = block.trim();
          if (!trimmed) return null;
          // heading: single line starting with #
          if (/^#{1,6}\s/.test(trimmed) && !trimmed.includes('\n') ) {
            const level = trimmed.match(/^#+/)![0].length;
            const content = trimmed.replace(/^#+\s+/, '');
            const sizeMap: Record<number, string> = {
              1: 'text-xl font-bold',
              2: 'text-lg font-bold',
              3: 'text-base font-semibold',
              4: 'text-[15px] font-semibold',
              5: 'text-sm font-semibold text-[var(--text-secondary)]',
              6: 'text-sm font-semibold text-[var(--text-tertiary)]',
            };
            const Tag = `h${Math.min(level, 6)}` as keyof React.JSX.IntrinsicElements;
            return React.createElement(Tag, { key: `h-${si}-${bi}`, className: `${sizeMap[level] || 'text-base font-bold'} leading-tight mt-1 mb-0.5` }, ...renderInline(content, `h-${si}-${bi}`));
          }
          // unordered list
          if (/^(\s*[-*]\s+.+(\n\s*[-*]\s+.+)*)$/.test(trimmed)) {
            const items = trimmed.split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
            return (
              <ul key={`ul-${si}-${bi}`} className="list-disc pl-5 space-y-1.5 marker:text-[var(--text-tertiary)]">
                {items.map((it, i) => (
                  <li key={i} className="leading-relaxed break-words text-[15px] sm:text-base">{renderInline(it, `li-${si}-${bi}-${i}`)}</li>
                ))}
              </ul>
            );
          }
          // ordered list
          if (/^(\s*\d+\.\s+.+(\n\s*\d+\.\s+.+)*)$/.test(trimmed)) {
            const items = trimmed.split('\n').map((l) => l.replace(/^\s*\d+\.\s+/, '').trim()).filter(Boolean);
            return (
              <ol key={`ol-${si}-${bi}`} className="list-decimal pl-5 space-y-1.5 marker:text-[var(--text-tertiary)]">
                {items.map((it, i) => (
                  <li key={i} className="leading-relaxed break-words text-[15px] sm:text-base">{renderInline(it, `oli-${si}-${bi}-${i}`)}</li>
                ))}
              </ol>
            );
          }
          // blockquote
          if (/^>\s?/.test(trimmed)) {
            const quote = trimmed.replace(/^>\s?/gm, '');
            return (
              <blockquote key={`q-${si}-${bi}`} className="border-l-2 border-[var(--border-strong)] pl-3.5 italic text-[var(--text-secondary)] leading-relaxed text-[15px] sm:text-base">
                {renderInline(quote, `q-${si}-${bi}`)}
              </blockquote>
            );
          }
          // paragraph with line breaks
          const lines = trimmed.split('\n');
          return (
            <p key={`p-${si}-${bi}`} className="leading-relaxed whitespace-pre-wrap break-words text-[15px] sm:text-base">
              {lines.map((line, li) => (
                <span key={li}>
                  {renderInline(line, `p-${si}-${bi}-${li}`)}
                  {li < lines.length - 1 ? <br /> : null}
                </span>
              ))}
            </p>
          );
        });
      })}
    </div>
  );
});

interface ChatMessageItemProps {
  msg: ChatMessage;
  isEditing: boolean;
  isCopied: boolean;
  editDraft: string;
  onEditDraftChange: (val: string) => void;
  onEditCancel: () => void;
  onEditSave: () => void;
  onCopy: (msg: ChatMessage) => void;
  onEditStart: (msg: ChatMessage) => void;
  onSaveArtifact?: (artifact: ArtifactRef) => void;
}

const ChatMessageItem = React.memo(function ChatMessageItem({
  msg,
  isEditing,
  isCopied,
  editDraft,
  onEditDraftChange,
  onEditCancel,
  onEditSave,
  onCopy,
  onEditStart,
  onSaveArtifact,
}: ChatMessageItemProps) {
  const isUser = msg.role === 'user';

  return (
    <div className={`flex group ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex flex-col gap-1 ${isUser ? 'items-end max-w-[88%] md:max-w-[72%]' : 'max-w-[88%] md:max-w-[72%] items-start'}`}>
        <div
          className={`w-full ${isUser ? 'px-5 py-3.5 rounded-[var(--radius-md)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-primary)]' : 'px-2 py-2 bg-transparent border-0 text-[var(--text-primary)]'}`}
        >
          {isEditing ? (
            <div className="flex flex-col gap-2 min-w-[240px]">
              <textarea
                value={editDraft}
                onChange={(e) => onEditDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    onEditCancel();
                  }
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    onEditSave();
                  }
                }}
                autoFocus
                rows={3}
                className="w-full min-h-[72px] max-h-[180px] p-3.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] outline-none text-[15px] sm:text-base text-[var(--text-primary)] leading-relaxed resize-none focus:border-[var(--accent)]"
                placeholder="Edit message..."
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={onEditCancel}
                  className="px-3.5 py-1.5 rounded-[var(--radius-sm)] neu-button text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Cancel
                </button>
                <button
                  onClick={onEditSave}
                  disabled={editDraft.trim().length === 0}
                  className={`px-4 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition ${editDraft.trim().length === 0 ? 'neu-button opacity-40 cursor-not-allowed' : 'neu-button-primary'}`}
                >
                  Save
                </button>
              </div>
              <div className="text-[11px] text-[var(--text-tertiary)] text-right">Esc to cancel • Ctrl+Enter to save</div>
            </div>
          ) : (
            <>
              {isUser ? (
                msg.text && <p className="text-[15px] sm:text-base leading-relaxed whitespace-pre-wrap break-words">{msg.text}</p>
              ) : (
                <>
                  {msg.text && <BasicMarkdown text={msg.text} />}
                  {msg.artifacts && msg.artifacts.length > 0 && (
                    <div className="w-full space-y-2.5 mt-2">
                      {msg.artifacts.map((art) => (
                        <ArtifactCard
                          key={art.artifactId}
                          artifact={art}
                          onSave={onSaveArtifact}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
              {msg.files && msg.files.length > 0 && (
                <div className={`flex flex-wrap gap-2 ${msg.text ? 'mt-3' : ''}`}>
                  {msg.files.map((f, i) => (
                    <span
                      key={`${f.name}-${i}`}
                      className="inline-flex items-center gap-2.5 pl-2.5 pr-3.5 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-sm max-w-[280px] border border-[var(--border-subtle)] text-[var(--text-secondary)]"
                    >
                      <span className="w-6 h-6 rounded-[4px] bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] grid place-items-center text-[10px] font-mono shrink-0">{fileLabel(f.name).slice(0, 3)}</span>
                      <span className="truncate font-medium text-[var(--text-primary)]">{f.name}</span>
                      {typeof f.size === "number" && f.size > 0 ? (
                        <span className="text-[var(--text-tertiary)] shrink-0 text-xs">{formatSize(f.size)}</span>
                      ) : null}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        {/* Icons at bottom of text box - outside bubble, bottom-aligned */}
        {isUser && !isEditing && (
          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto">
            <button
              onClick={() => onCopy(msg)}
              className="w-8 h-8 grid place-items-center rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              title={isCopied ? 'Copied' : 'Copy'}
              aria-label={isCopied ? 'Copied' : 'Copy message'}
            >
              {isCopied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--status-success)]">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3.5" />
                </svg>
              )}
            </button>
            <button
              onClick={() => onEditStart(msg)}
              className="w-8 h-8 grid place-items-center rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              title="Edit"
              aria-label="Edit message"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

export default function ChatArea({
  messages = [],
  onEditMessage,
  onAttachFiles,
  onSaveArtifact,
  isRunning = false,
  runState = null,
  activeRoute = null,
  runEvents = [],
}: Props) {
  const hasMessages = messages.length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

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

  // Auto scroll on new messages or running state changes if user is near bottom
  useEffect(() => {
    if (autoScroll) {
      scrollToBottom('smooth');
    }
  }, [messages, isRunning, runEvents?.length, autoScroll, scrollToBottom]);

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

  const showDropError = useCallback((msg: string) => {
    setDropError(msg);
    window.setTimeout(() => setDropError(null), 4000);
  }, []);

  const handleFiles = useCallback((incoming: File[] | FileList) => {
    const arr = Array.from(incoming as File[]);
    if (!arr.length || !onAttachFiles) {
      if (!onAttachFiles && arr.length) showDropError('File drop not enabled');
      return;
    }
    const { rejected } = onAttachFiles(arr);
    if (rejected.length) {
      const names = rejected.map((f) => `${f.name} (${formatSize(f.size)})`).join(', ');
      showDropError(`File too big: ${names} — limit is 10MB`);
    }
  }, [onAttachFiles, showDropError]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) handleFiles(files);
  }, [handleFiles]);

  return (
    <div
      className="flex-1 flex flex-col overflow-hidden relative bg-[var(--bg-canvas)]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`flex-1 overflow-y-auto p-4 md:p-6 space-y-3 transition-colors ${isDragOver ? 'bg-[var(--bg-surface-raised)]/60' : ''}`}
      >
        {!hasMessages && !isRunning ? (
          <div className="flex flex-col items-center justify-center min-h-[60%] py-16 text-center">
            <p className="text-xs text-[var(--text-tertiary)]">Air-gapped workspace ready.</p>
          </div>
        ) : null}

        {messages.map((msg) => (
          <ChatMessageItem
            key={msg.id}
            msg={msg}
            isEditing={editingId === msg.id}
            isCopied={copiedId === msg.id}
            editDraft={editDraft}
            onEditDraftChange={setEditDraft}
            onEditCancel={handleEditCancel}
            onEditSave={handleEditSave}
            onCopy={handleCopy}
            onEditStart={handleEditStart}
            onSaveArtifact={onSaveArtifact}
          />
        ))}

        {isRunning && (
          <RunWaitingIndicator
            isRunning={isRunning}
            runState={runState ?? null}
            activeRoute={activeRoute}
            runEvents={runEvents}
          />
        )}

        <div ref={bottomRef} aria-hidden />
      </div>

      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--bg-canvas)]/85 border-2 border-dashed border-[var(--border-muted)] rounded-[var(--radius-md)] m-2 pointer-events-none">
          <div className="flex flex-col items-center gap-2 neu-card px-6 py-4">
            <div className="w-10 h-10 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] grid place-items-center text-[var(--text-secondary)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </div>
          </div>
        </div>
      )}

      {dropError && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 p-2.5 rounded-[var(--radius-sm)] neu-card border border-[var(--status-error)]/40 text-xs text-[var(--status-error)] flex items-center gap-2 max-w-[90%]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
          <span className="flex-1 leading-tight">{dropError}</span>
          <button onClick={() => setDropError(null)} className="w-6 h-6 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs shrink-0 pointer-events-auto">✕</button>
        </div>
      )}

      {showJump && (
        <button
          onClick={() => {
            setAutoScroll(true);
            scrollToBottom('smooth');
            setShowJump(false);
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] neu-button text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shadow-sm"
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
