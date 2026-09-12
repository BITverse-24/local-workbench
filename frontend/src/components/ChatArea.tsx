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
      nodes.push(<strong key={`${keyPrefix}-b-${idx++}`} className="font-semibold text-white">{m[1]}</strong>);
    } else if (m[2]) {
      nodes.push(<strong key={`${keyPrefix}-b2-${idx++}`} className="font-semibold text-white">{m[2]}</strong>);
    } else if (m[3]) {
      nodes.push(<em key={`${keyPrefix}-i-${idx++}`} className="italic">{m[3]}</em>);
    } else if (m[4]) {
      nodes.push(<em key={`${keyPrefix}-i2-${idx++}`} className="italic">{m[4]}</em>);
    } else if (m[5]) {
      nodes.push(<code key={`${keyPrefix}-c-${idx++}`} className="px-1 py-0.5 rounded bg-white/10 border border-white/10 text-xs font-mono">{m[5]}</code>);
    } else if (m[6] && m[7]) {
      nodes.push(<a key={`${keyPrefix}-a-${idx++}`} href={m[7]} target="_blank" rel="noreferrer" className="underline underline-offset-2 decoration-white/30 hover:decoration-white/60 text-white/90">{m[6]}</a>);
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
      <pre className="p-3 pr-12 rounded-xl bg-[#0F0F0F] border border-[#2A2A2A] overflow-x-auto text-xs font-mono whitespace-pre-wrap break-words">
        <code>{highlightCode(code)}</code>
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 w-7 h-7 grid place-items-center rounded-full bg-[#1F1F1F] border border-[#2A2A2A] text-white/60 hover:text-white hover:brightness-125 transition-colors opacity-0 group-hover/code:opacity-100 group-focus-within/code:opacity-100 focus:opacity-100 transition-opacity duration-150 pointer-events-none group-hover/code:pointer-events-auto group-focus-within/code:pointer-events-auto"
        title={copied ? 'Copied!' : 'Copy code'}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? (
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
      {lang ? <span className="absolute bottom-1.5 right-2 text-[9px] tracking-wide uppercase opacity-30 pointer-events-none">{lang}</span> : null}
    </div>
  );
}

function BasicMarkdown({ text }: { text: string }) {
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
    <div className="space-y-2.5">
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
              1: 'text-base font-bold',
              2: 'text-[15px] font-bold',
              3: 'text-sm font-semibold',
              4: 'text-sm font-semibold',
              5: 'text-xs font-semibold uppercase tracking-wide opacity-80',
              6: 'text-xs font-semibold uppercase tracking-wide opacity-60',
            };
            const Tag = `h${Math.min(level, 6)}` as keyof React.JSX.IntrinsicElements;
            return React.createElement(Tag, { key: `h-${si}-${bi}`, className: `${sizeMap[level] || 'text-sm font-bold'} leading-tight` }, ...renderInline(content, `h-${si}-${bi}`));
          }
          // unordered list
          if (/^(\s*[-*]\s+.+(\n\s*[-*]\s+.+)*)$/.test(trimmed)) {
            const items = trimmed.split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
            return (
              <ul key={`ul-${si}-${bi}`} className="list-disc pl-5 space-y-1 marker:text-white/40">
                {items.map((it, i) => (
                  <li key={i} className="leading-relaxed break-words">{renderInline(it, `li-${si}-${bi}-${i}`)}</li>
                ))}
              </ul>
            );
          }
          // ordered list
          if (/^(\s*\d+\.\s+.+(\n\s*\d+\.\s+.+)*)$/.test(trimmed)) {
            const items = trimmed.split('\n').map((l) => l.replace(/^\s*\d+\.\s+/, '').trim()).filter(Boolean);
            return (
              <ol key={`ol-${si}-${bi}`} className="list-decimal pl-5 space-y-1 marker:text-white/40">
                {items.map((it, i) => (
                  <li key={i} className="leading-relaxed break-words">{renderInline(it, `oli-${si}-${bi}-${i}`)}</li>
                ))}
              </ol>
            );
          }
          // blockquote
          if (/^>\s?/.test(trimmed)) {
            const quote = trimmed.replace(/^>\s?/gm, '');
            return (
              <blockquote key={`q-${si}-${bi}`} className="border-l-2 border-white/20 pl-3 italic opacity-80 leading-relaxed">
                {renderInline(quote, `q-${si}-${bi}`)}
              </blockquote>
            );
          }
          // paragraph with line breaks
          const lines = trimmed.split('\n');
          return (
            <p key={`p-${si}-${bi}`} className="leading-relaxed whitespace-pre-wrap break-words text-sm">
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
}

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
      className="flex-1 flex flex-col overflow-hidden relative"
      style={{ background: '#1A1A1A' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`flex-1 overflow-y-auto p-4 md:p-6 space-y-2 transition-colors ${isDragOver ? 'bg-[#252525]/60' : ''}`}
      >
        {!hasMessages && !isRunning ? (
          <div className="flex flex-col items-center justify-center min-h-[60%] py-16 text-center animate-apple-fade">
            <p className="text-sm text-white/40">Welcome! Ready when you are.</p>
          </div>
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
                  className={`w-full ${isUser ? 'px-5 py-3.5 rounded-[18px] rounded-br-[6px] neu-raised' : 'px-2 py-2 bg-transparent border-0'}`}
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
                      {isUser ? (
                        msg.text && <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{msg.text}</p>
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
                        <div className={`flex flex-wrap gap-2 ${msg.text ? 'mt-2.5' : ''}`}>
                          {msg.files.map((f, i) => (
                            <span
                              key={`${f.name}-${i}`}
                              className="inline-flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full neu-pressed text-xs max-w-[240px] border border-white/10"
                            >
                              <span className="w-6 h-6 rounded-full bg-white/15 grid place-items-center text-[8px] font-bold shrink-0">{fileLabel(f.name).slice(0, 3)}</span>
                              <span className="truncate font-medium text-white/90">{f.name}</span>
                              {typeof f.size === "number" && f.size > 0 ? (
                                <span className="opacity-50 shrink-0 text-[10px]">{formatSize(f.size)}</span>
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
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#1A1A1A]/75 backdrop-blur-[1px] border-2 border-dashed border-white/20 rounded-xl m-2 pointer-events-none animate-apple-fade">
          <div className="flex flex-col items-center gap-2 neu-card px-6 py-4">
            <div className="w-10 h-10 rounded-full neu-pressed grid place-items-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </div>
          </div>
        </div>
      )}

      {dropError && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 p-2.5 rounded-xl neu-card border border-red-500/30 text-xs text-red-400 flex items-center gap-2 animate-apple-message max-w-[90%]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
          <span className="flex-1 leading-tight">{dropError}</span>
          <button onClick={() => setDropError(null)} className="w-6 h-6 rounded-full neu-button grid place-items-center text-xs shrink-0 pointer-events-auto">✕</button>
        </div>
      )}

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
