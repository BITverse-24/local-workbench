import { useRef, useEffect, useState, useMemo } from 'react';

type Props = {
  input: string;
  setInput: (v: string) => void;
  plusOpen?: boolean;
  setPlusOpen?: (v: boolean | ((p: boolean) => boolean)) => void;
  plusBtnRef?: React.RefObject<HTMLButtonElement | null>;
  searchActive?: boolean;
  setSearchActive?: (v: boolean) => void;
  onVoice?: () => void;
  onSend?: () => void;
  attachedFiles?: File[];
  onAttachFiles?: (files: File[]) => { added: number; rejected: File[] };
  onRemoveFile?: (index: number) => void;
  disabled?: boolean;
  groundingEnabled?: boolean;
  setGroundingEnabled?: (v: boolean | ((p: boolean) => boolean)) => void;
  mode?: "chat" | "agent";
  onToggleMode?: () => void;
};


function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeLabel(file: File): string {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (['pdf'].includes(ext)) return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'DOC';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'SHEET';
  if (['ppt', 'pptx'].includes(ext)) return 'SLIDES';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'heic'].includes(ext)) return 'IMAGE';
  if (['txt', 'md'].includes(ext)) return 'TEXT';
  if (['zip', 'rar', '7z'].includes(ext)) return 'ARCHIVE';
  return ext ? ext.toUpperCase() : 'FILE';
}

function FileTypeIcon({ file }: { file: File }) {
  const label = fileTypeLabel(file);
  const isImage = file.type.startsWith('image/');
  const isPdf = label === 'PDF';
  if (isImage) {
    return (
      <span className="w-7 h-7 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] grid place-items-center shrink-0 text-[10px] font-medium text-[var(--text-secondary)]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </span>
    );
  }
  if (isPdf) {
    return <span className="w-7 h-7 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] grid place-items-center shrink-0 text-[9px] font-mono text-[var(--text-secondary)]">PDF</span>;
  }
  return <span className="w-7 h-7 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] grid place-items-center shrink-0 text-[9px] font-mono text-[var(--text-secondary)]">{label.slice(0, 4)}</span>;
}

export default function InputBar({ input, setInput, onSend, attachedFiles = [], onAttachFiles, onRemoveFile, disabled, groundingEnabled = false, setGroundingEnabled, mode = "chat", onToggleMode }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const canSend = !disabled && (input.trim().length > 0 || attachedFiles.length > 0);

  const showError = (msg: string) => {
    setAttachError(msg);
    window.setTimeout(() => setAttachError(null), 4000);
  };

  const handleFiles = (incoming: File[] | FileList) => {
    const arr = Array.from(incoming as File[]);
    if (!arr.length || !onAttachFiles) return;
    const { rejected } = onAttachFiles(arr);
    if (rejected.length) {
      const names = rejected.map((f) => `${f.name} (${formatSize(f.size)})`).join(', ');
      showError(`File too big: ${names} — limit is 10MB`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend && onSend) onSend();
    }
    // Shift+Enter: allow default newline insertion (cursor goes to next line)
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      // let text paste happen too? Prevent only if files are present and we want to attach
      // Don't preventDefault for text – just attach files additionally
      handleFiles(files);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) handleFiles(files);
  };

  useEffect(() => {
    if (input === '' && textareaRef.current) {
      textareaRef.current.style.height = '42px';
    }
  }, [input]);

  // image previews for attached image files
  const imagePreviews = useMemo(() => {
    const map = new Map<string, string>();
    attachedFiles.forEach((f) => {
      if (f.type.startsWith('image/')) {
        map.set(f.name + f.size + f.lastModified, URL.createObjectURL(f));
      }
    });
    return map;
  }, [attachedFiles]);

  useEffect(() => {
    return () => {
      imagePreviews.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [imagePreviews]);

  return (
    <div
      className="p-3 md:p-4 flex-shrink-0 bg-[var(--bg-surface)] border-t border-[var(--border-subtle)]"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <div className="w-full max-w-[96%] xl:max-w-[92%] mx-auto flex flex-col gap-2">
        {/* Attachment chips */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachedFiles.map((file, idx) => {
              const preview = imagePreviews.get(file.name + file.size + file.lastModified);
              return (
                <div key={`${file.name}-${file.size}-${file.lastModified}-${idx}`} className="group flex items-center gap-2.5 pl-2 pr-2 py-1.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-sm text-[var(--text-secondary)] max-w-[260px]">
                  {preview ? (
                    <img src={preview} alt={file.name} className="w-8 h-8 rounded-[4px] object-cover shrink-0 border border-[var(--border-subtle)]" />
                  ) : (
                    <FileTypeIcon file={file} />
                  )}
                  <div className="flex-1 min-w-0 leading-tight">
                    <div className="truncate font-medium text-[var(--text-primary)] max-w-[140px] text-sm">{file.name}</div>
                    <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{formatSize(file.size)} • {fileTypeLabel(file)}</div>
                  </div>
                  <button
                    onClick={() => onRemoveFile?.(idx)}
                    className="w-6 h-6 rounded-[var(--radius-sm)] neu-button grid place-items-center shrink-0 opacity-60 hover:opacity-100 text-[var(--text-secondary)]"
                    title="Remove file"
                    aria-label={`Remove ${file.name}`}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {attachError && (
          <div className="p-3 rounded-[var(--radius-sm)] neu-card border border-[var(--status-error)]/40 text-xs sm:text-sm text-[var(--status-error)] flex items-center gap-2">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            <span className="flex-1 leading-tight">{attachError}</span>
            <button onClick={() => setAttachError(null)} className="w-6 h-6 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs shrink-0">✕</button>
          </div>
        )}

        {/* Input row */}
        <div
          className={`relative flex items-end gap-2.5 rounded-[var(--radius-md)] p-2.5 sm:p-3 bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] focus-within:border-white/50 transition-colors ${isDragOver ? 'border-white/60' : ''}`}
        >
          {/* Attach docs/files button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-10 h-10 rounded-[var(--radius-sm)] neu-button grid place-items-center shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title="Attach files"
            aria-label="Attach files"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) handleFiles(e.target.files);
              e.target.value = '';
            }}
          />

          {/* SOP Grounding toggle button */}
          {setGroundingEnabled && (
            <button
              type="button"
              onClick={() => setGroundingEnabled((prev: boolean) => !prev)}
              className={`h-10 px-3.5 rounded-[var(--radius-sm)] inline-flex items-center gap-2 text-xs sm:text-[13px] font-medium shrink-0 transition-all ${
                groundingEnabled
                  ? 'bg-[var(--accent-muted)] text-[var(--accent)] border border-[var(--accent)]/40 hover:bg-[var(--accent-muted)]'
                  : 'neu-button opacity-60 hover:opacity-100 text-[var(--text-tertiary)]'
              }`}
              title={groundingEnabled ? 'SOP grounding active (click to disable)' : 'SOP grounding disabled (click to enable)'}
              aria-label={groundingEnabled ? 'Disable SOP grounding' : 'Enable SOP grounding'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={groundingEnabled ? 'text-[var(--accent)]' : 'opacity-60'}>
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <span className="hidden sm:inline">Grounding</span>
              <span className={`w-1.5 h-1.5 rounded-full ${groundingEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--text-tertiary)]'}`} />
            </button>
          )}

          {/* Execution Mode toggle button (Chat / Agent) */}
          {onToggleMode && (
            <button
              type="button"
              onClick={onToggleMode}
              className={`h-10 px-3.5 rounded-[var(--radius-sm)] inline-flex items-center gap-2 text-xs sm:text-[13px] font-medium shrink-0 transition-all ${
                mode === 'agent'
                  ? 'bg-[var(--accent-muted)] text-[var(--accent)] border border-[var(--accent)]/40 hover:bg-[var(--accent-muted)]'
                  : 'neu-button opacity-70 hover:opacity-100 text-[var(--text-secondary)]'
              }`}
              title={
                mode === 'agent'
                  ? 'Agent mode active: Workspace modifications & command execution enabled (subject to approvals). Click to switch to Chat mode.'
                  : 'Chat mode active: Reasoning & document analysis (read-only; workspace mutation disabled). Click to switch to Agent mode.'
              }
              aria-label={mode === 'agent' ? 'Switch to Chat mode' : 'Switch to Agent mode'}
            >
              {mode === 'agent' ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--accent)]">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-70">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
              <span className="hidden sm:inline">{mode === 'agent' ? 'Agent' : 'Chat'}</span>
              <span className={`w-1.5 h-1.5 rounded-full ${mode === 'agent' ? 'bg-[var(--accent)]' : 'bg-emerald-400'}`} />
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="opacity-70">
                <path d="m4 6 4 4 4-4" />
              </svg>
            </button>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={!!disabled}
            placeholder={disabled ? 'Run in progress…' : attachedFiles.length ? 'Add a message…' : 'Write your prompt...'}
            rows={1}
            className="flex-1 bg-transparent border-none outline-none px-2.5 md:px-3.5 py-2.5 min-w-0 text-[15px] sm:text-base text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] resize-none overflow-y-auto leading-relaxed max-h-[160px] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            style={{ height: '42px', scrollbarWidth: 'none' } as React.CSSProperties}
          />

          <button
            onClick={onSend}
            disabled={!canSend}
            className={`px-6 py-2.5 font-medium text-sm h-10 shrink-0 rounded-[var(--radius-sm)] transition ${canSend ? 'neu-button-primary' : 'neu-button opacity-40 cursor-not-allowed text-[var(--text-tertiary)]'}`}
          >
            Send
          </button>
        </div>

      </div>
    </div>
  );
}
