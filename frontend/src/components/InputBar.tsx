import { useRef, useEffect, useState, useMemo } from 'react';

type Props = {
  input: string;
  setInput: (v: string) => void;
  plusOpen: boolean;
  setPlusOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  plusBtnRef: React.RefObject<HTMLButtonElement | null>;
  searchActive: boolean;
  setSearchActive: (v: boolean) => void;
  onVoice: () => void;
  onSend?: () => void;
  attachedFiles?: File[];
  onAttachFiles?: (files: File[]) => { added: number; rejected: File[] };
  onRemoveFile?: (index: number) => void;
  disabled?: boolean;
  groundingEnabled?: boolean;
  setGroundingEnabled?: (v: boolean | ((p: boolean) => boolean)) => void;
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
  // simple icon based on type
  if (isImage) {
    return (
      <span className="w-8 h-8 rounded-lg neu-pressed grid place-items-center shrink-0 text-[10px] font-bold opacity-80">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </span>
    );
  }
  if (isPdf) {
    return <span className="w-8 h-8 rounded-lg neu-pressed grid place-items-center shrink-0 text-[9px] font-bold bg-red-500/10 text-red-300 border border-red-500/20">PDF</span>;
  }
  return <span className="w-8 h-8 rounded-lg neu-pressed grid place-items-center shrink-0 text-[8px] font-bold opacity-70">{label.slice(0, 4)}</span>;
}

export default function InputBar({ input, setInput, plusOpen, setPlusOpen, plusBtnRef, searchActive, setSearchActive, onVoice, onSend, attachedFiles = [], onAttachFiles, onRemoveFile, disabled, groundingEnabled = true, setGroundingEnabled }: Props) {
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
      textareaRef.current.style.height = '36px';
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
      className="p-3 md:p-4 flex-shrink-0 animate-apple-up delay-300"
      style={{ background: '#1F1F1F' }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        // only leave if leaving the container
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <div className="max-w-3xl mx-auto flex flex-col gap-2">
        {/* Attachment chips */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 animate-apple-message">
            {attachedFiles.map((file, idx) => {
              const preview = imagePreviews.get(file.name + file.size + file.lastModified);
              return (
                <div key={`${file.name}-${file.size}-${file.lastModified}-${idx}`} className="group flex items-center gap-2 pl-1.5 pr-1 py-1 rounded-full neu-card text-xs max-w-[220px] animate-apple-scaleIn">
                  {preview ? (
                    <img src={preview} alt={file.name} className="w-8 h-8 rounded-full object-cover shrink-0 border border-[#2A2A2A]" />
                  ) : (
                    <FileTypeIcon file={file} />
                  )}
                  <div className="flex-1 min-w-0 leading-none">
                    <div className="truncate font-medium max-w-[120px]">{file.name}</div>
                    <div className="text-[10px] opacity-50">{formatSize(file.size)} • {fileTypeLabel(file)}</div>
                  </div>
                  <button
                    onClick={() => onRemoveFile?.(idx)}
                    className="w-6 h-6 rounded-full neu-button grid place-items-center shrink-0 opacity-60 hover:opacity-100"
                    title="Remove file"
                    aria-label={`Remove ${file.name}`}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
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
          <div className="p-2.5 rounded-xl neu-card border border-red-500/30 text-xs text-red-400 flex items-center gap-2 animate-apple-message">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
            <span className="flex-1 leading-tight">{attachError}</span>
            <button onClick={() => setAttachError(null)} className="w-6 h-6 rounded-full neu-button grid place-items-center text-xs shrink-0">✕</button>
          </div>
        )}

        {/* Input row */}
        <div
          className={`relative flex items-end gap-1.5 rounded-[20px] p-2 neu-pressed transition-all ${isDragOver ? 'ring-1 ring-white/20 border-white/20 bg-[#252525]' : ''}`}
          style={{ borderColor: isDragOver ? 'rgba(255,255,255,0.18)' : undefined }}
        >
          <button
            ref={plusBtnRef as React.RefObject<HTMLButtonElement>}
            onClick={() => setPlusOpen((o: boolean) => !o)}
            className={`w-9 h-9 rounded-full neu-button grid place-items-center shrink-0 transition-transform duration-300 ${plusOpen ? 'neu-pressed rotate-45' : ''}`}
            title="More options"
            style={{ transitionTimingFunction: 'cubic-bezier(0.16,1,0.3,1)' }}
          >
            ＋
          </button>

          {/* Attach docs/files button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-9 h-9 rounded-full neu-button grid place-items-center shrink-0"
            title="Attach files"
            aria-label="Attach files"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept=".pdf,.doc,.docx,.txt,.md,.csv,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif,.svg,.zip,.rar,.heic,application/pdf,image/*,text/*"
            onChange={(e) => {
              if (e.target.files) handleFiles(e.target.files);
              // reset so same file can be selected again
              e.target.value = '';
            }}
          />

          {/* SOP Grounding toggle button */}
          {setGroundingEnabled && (
            <button
              type="button"
              onClick={() => setGroundingEnabled((prev: boolean) => !prev)}
              className={`h-9 px-2.5 rounded-full inline-flex items-center gap-1.5 text-xs font-medium shrink-0 transition-all ${
                groundingEnabled
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25'
                  : 'neu-button opacity-50 hover:opacity-80 text-white/50'
              }`}
              title={groundingEnabled ? 'SOP Grounding active (click to disable)' : 'SOP Grounding disabled (click to enable)'}
              aria-label={groundingEnabled ? 'Disable SOP Grounding' : 'Enable SOP Grounding'}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={groundingEnabled ? 'text-emerald-400' : 'opacity-60'}>
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              <span className="hidden sm:inline">Grounding</span>
              <span className={`w-1.5 h-1.5 rounded-full ${groundingEnabled ? 'bg-emerald-400 animate-pulse' : 'bg-white/30'}`} />
            </button>
          )}

          {searchActive && (
            <span className="group inline-flex items-center gap-0 group-hover:gap-1.5 pl-2 pr-2 group-hover:pr-1 py-1 rounded-full neu-card text-xs shrink-0 animate-apple-scaleIn transition-all duration-200">
              <span className="p-1 rounded-full neu-pressed grid place-items-center shrink-0">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="16.5" y1="16.5" x2="21" y2="21" />
                </svg>
              </span>
              Search
              <button
                onClick={() => setSearchActive(false)}
                className="w-0 h-5 rounded-full neu-button grid place-items-center opacity-0 group-hover:w-5 group-hover:opacity-100 overflow-hidden shrink-0 transition-all duration-200"
                title="Remove search"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </span>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={!!disabled}
            placeholder={searchActive ? 'Search the web…' : disabled ? 'Run in progress…' : attachedFiles.length ? 'Add a message…' : 'Write your prompt...'}
            rows={1}
            className="flex-1 bg-transparent border-none outline-none px-2 md:px-3 py-2 min-w-0 text-sm placeholder:text-white/30 resize-none overflow-y-auto leading-5 max-h-[120px] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            style={{ height: '36px', scrollbarWidth: 'none' } as React.CSSProperties}
          />

          <button onClick={onVoice} className="w-9 h-9 rounded-full neu-button grid place-items-center shrink-0" title="Voice">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z" />
              <path d="M19 10a7 7 0 0 1-14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </button>

          <button
            onClick={onSend}
            disabled={!canSend}
            className={`px-5 py-2 font-semibold text-sm shrink-0 rounded-full transition ${canSend ? 'neu-button-primary' : 'neu-button opacity-40 cursor-not-allowed'}`}
          >
            Send
          </button>
        </div>

      </div>
    </div>
  );
}
