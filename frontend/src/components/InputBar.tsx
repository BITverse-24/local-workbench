import ExecutionSupport from "./ExecutionSupport";
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
  mode?: ExecutionMode;
  onModeChange?: (mode:ExecutionMode) => void;
  hasWorkspace?: boolean;
  executionCapabilities?: ExecutionCapabilities | null;
  executionCapabilitiesError?: string | null;
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
  if (['txt', 'md', 'json', 'yaml', 'yml', 'toml'].includes(ext)) return 'TEXT';
  if (['py', 'ts', 'tsx', 'js', 'jsx', 'rs', 'go', 'c', 'cpp', 'h'].includes(ext)) return 'CODE';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'ARCHIVE';
  return ext ? ext.toUpperCase().slice(0, 4) : 'FILE';
}

function FileTypeBadge({ file }: { file: File }) {
  const label = fileTypeLabel(file);
  const isImage = file.type.startsWith('image/');
  const isPdf = label === 'PDF';
  const isSheet = label === 'SHEET';
  const isDoc = label === 'DOC';
  const isCode = label === 'CODE';

  if (isImage) {
    return (
      <span className="w-7 h-7 rounded-lg bg-[#252B33] border border-[#3E4756] flex items-center justify-center shrink-0 text-[#C4C9D0]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </span>
    );
  }

  let badgeColor = "text-[#C4C9D0] bg-[#252B33] border-[#3E4756]";
  if (isPdf) badgeColor = "text-rose-300 bg-rose-950/50 border-rose-700/60";
  else if (isSheet) badgeColor = "text-emerald-300 bg-emerald-950/50 border-emerald-700/60";
  else if (isDoc) badgeColor = "text-sky-300 bg-sky-950/50 border-sky-700/60";
  else if (isCode) badgeColor = "text-amber-300 bg-amber-950/50 border-amber-700/60";

  return (
    <span className={`w-7 h-7 rounded-lg border flex items-center justify-center shrink-0 text-[9px] font-mono font-bold tracking-wider ${badgeColor}`}>
      {label.slice(0, 4)}
    </span>
  );
}

export default function InputBar({
  input,
  setInput,
  onSend,
  attachedFiles = [],
  onAttachFiles,
  onRemoveFile,
  disabled,
  groundingEnabled = false,
  setGroundingEnabled,
  mode = "chat",
  onModeChange,
  hasWorkspace=false,
  executionCapabilities=null,
  executionCapabilitiesError,
  onVoice,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const canSend = !disabled && (input.trim().length > 0 || attachedFiles.length > 0);
  const [hoveredMode, setHoveredMode] = useState<ExecutionMode | null>(null);
  const modeOptions = ["chat", "work", "agent"] as const;
  const slideMode = hoveredMode ?? mode;

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
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.max(56, Math.min(el.scrollHeight, 180)) + 'px';
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
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
      textareaRef.current.style.height = '56px';
    }
  }, [input]);

  // Image previews for attached images
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
      className="p-3 sm:p-4 md:px-6 md:pb-5 md:pt-3 flex-shrink-0 bg-[#0E1115] border-t border-[#262C34] transition-colors"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false);
      }}
      onDrop={handleDrop}
    >
      <div className="w-full max-w-[96%] xl:max-w-[94%] 2xl:max-w-[90%] mx-auto flex flex-col gap-2.5">
        <ExecutionSupport capabilities={executionCapabilities} mode={mode} error={executionCapabilitiesError} />
        {/* Error notification banner */}
        {attachError && (
          <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/40 text-xs sm:text-sm text-rose-300 flex items-center gap-2.5 shadow-md animate-apple-fade">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-rose-400">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="flex-1 leading-tight font-medium">{attachError}</span>
            <button
              type="button"
              onClick={() => setAttachError(null)}
              className="w-6 h-6 rounded-md hover:bg-rose-900/50 text-rose-300 flex items-center justify-center text-xs shrink-0 transition-colors"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}

        {/* The High-Contrast Integrated Prompt Card */}
        <div
          className={`
            group relative flex flex-col rounded-2xl
            bg-[#1A1F26] border-2
            shadow-2xl shadow-black/70
            transition-all duration-200
            ${isDragOver
              ? 'border-[var(--accent)] ring-4 ring-[var(--accent)]/30 bg-[#1D2530]'
              : 'border-[#333C48] hover:border-[#445060] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/30'
            }
          `}
        >
          {/* Drag Over Overlay */}
          {isDragOver && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-2xl bg-[#1A1F26]/95 backdrop-blur-sm border-2 border-dashed border-[var(--accent)] pointer-events-none">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--accent)]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                Drop files to attach to conversation
              </div>
            </div>
          )}

          {/* Attachment Tray (Inside Card) */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3.5 pb-2 border-b border-[#2B333E]">
              {attachedFiles.map((file, idx) => {
                const preview = imagePreviews.get(file.name + file.size + file.lastModified);
                return (
                  <div
                    key={`${file.name}-${file.size}-${file.lastModified}-${idx}`}
                    className="group relative flex items-center gap-2 pl-2 pr-2 py-1.5 rounded-lg bg-[#242B34] hover:bg-[#2C3440] border border-[#3E4756] hover:border-[#525E72] text-xs text-[#E6E8EA] transition-all max-w-[260px] shadow-sm"
                  >
                    {preview ? (
                      <img src={preview} alt={file.name} className="w-7 h-7 rounded-md object-cover shrink-0 border border-[#3E4756]" />
                    ) : (
                      <FileTypeBadge file={file} />
                    )}
                    <div className="flex-1 min-w-0 pr-1 leading-tight">
                      <div className="truncate font-medium text-[#E6E8EA] text-xs" title={file.name}>
                        {file.name}
                      </div>
                      <div className="text-[10px] text-[#9AA2AD] font-mono mt-0.5">
                        {formatSize(file.size)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveFile?.(idx)}
                      className="w-5 h-5 rounded-md flex items-center justify-center text-[#9AA2AD] hover:text-white hover:bg-white/10 transition-colors"
                      title="Remove file"
                      aria-label={`Remove ${file.name}`}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Top area: Spacious, comfortable multiline input */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={!!disabled}
            placeholder={
              disabled
                ? 'Task execution in progress…'
                : attachedFiles.length
                ? 'Add instructions for the attached files…'
                : 'Write a prompt, request code changes, inspect drawings, or ask a question…'
            }
            rows={1}
            className="w-full bg-transparent border-none outline-none px-4 pt-3.5 pb-2.5 min-w-0 text-[15px] sm:text-base text-[#F0F2F5] placeholder:text-[#8D96A0] resize-none overflow-y-auto leading-relaxed max-h-[180px] [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
            style={{ height: '56px', scrollbarWidth: 'none' } as React.CSSProperties}
          />

          {/* Bottom area: Toolbar with controls & Send */}
          <div className="flex items-center justify-between px-3.5 pb-3 pt-2 gap-2 border-t border-[#262C34]">
            {/* Left tool cluster */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Attach Button */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="h-9 px-3 rounded-lg flex items-center gap-2 text-xs font-medium text-[#D8DEE4] hover:text-white bg-[#252A32] hover:bg-[#2F3640] active:bg-[#20252C] border border-[#3E4756] hover:border-[#525E72] shadow-sm transition-all active:scale-95"
                title="Attach files (PDF, images, spreadsheets, documents — max 10MB)"
                aria-label="Attach files"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#A0AAB5]">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                <span className="font-medium">Attach</span>
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

              {onModeChange && (
                <div className="rounded-full border border-white/[0.09] bg-[#15191D] p-1 shadow-[0_2px_8px_rgba(0,0,0,0.18)]" role="group" aria-label="Execution mode">
                  <div className="relative grid grid-cols-3" onMouseLeave={() => setHoveredMode(null)} onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHoveredMode(null);
                  }}>
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 z-0 w-1/3 rounded-full border border-white/[0.09] bg-[#2A3238] shadow-[0_1px_3px_rgba(0,0,0,0.22)] transition-transform duration-200 ease-out motion-reduce:transition-none"
                      style={{ transform: `translateX(${modeOptions.indexOf(slideMode) * 100}%)` }}
                    />
                  {modeOptions.map((value) => {
                    const selected = mode === value;
                    const highlighted = slideMode === value;
                    const agentNeedsWorkspace = value === "agent" && !hasWorkspace;
                    return (
                      <div key={value} className={value === "agent" ? "relative group/agent" : "relative"}>
                        <button
                          type="button"
                          onMouseEnter={() => setHoveredMode(value)}
                          onFocus={() => setHoveredMode(value)}
                          onClick={() => {
                            if (!disabled && !agentNeedsWorkspace) onModeChange(value);
                          }}
                          disabled={disabled}
                          aria-disabled={agentNeedsWorkspace || undefined}
                          aria-pressed={selected}
                          aria-describedby={agentNeedsWorkspace ? "agent-workspace-tooltip" : undefined}
                          title={value === "chat" ? "Answer from conversation and selected sources" : value === "work" ? "Compute and create output files" : hasWorkspace ? "Inspect and change the bound workspace" : undefined}
                          className={`relative z-10 h-8 w-[72px] rounded-full text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#94A3AD]/50 disabled:cursor-not-allowed disabled:opacity-45 ${agentNeedsWorkspace && !highlighted
                            ? "cursor-help text-[#77818A] hover:text-[#AEB7BE]"
                            : highlighted || selected
                              ? "text-[#EDF1F3]"
                              : "text-[#A8B0B7] hover:text-[#D7DDE1]"
                          }`}
                        >
                          {value[0].toUpperCase() + value.slice(1)}
                        </button>
                        {agentNeedsWorkspace && !disabled && (
                          <div id="agent-workspace-tooltip" role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+10px)] left-1/2 z-30 w-52 -translate-x-1/2 translate-y-1 rounded-xl border border-white/[0.11] bg-[#1B2025] px-3 py-2.5 text-left opacity-0 shadow-[0_10px_30px_rgba(0,0,0,0.38)] transition-all duration-150 group-hover/agent:translate-y-0 group-hover/agent:opacity-100 group-focus-within/agent:translate-y-0 group-focus-within/agent:opacity-100">
                            <div className="flex items-start gap-2">
                              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border border-[#758493]/35 text-[10px] leading-none text-[#A8B7C4]">i</span>
                              <span className="text-[11px] leading-relaxed text-[#CBD2D8]">Enable a workspace to use Agent.</span>
                            </div>
                            <span className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-white/[0.11] bg-[#1B2025]" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  </div>
                </div>
              )}

              {/* SOP Grounding Toggle */}
              {setGroundingEnabled && (
                <button
                  type="button"
                  onClick={() => setGroundingEnabled((prev: boolean) => !prev)}
                  className={`h-9 px-3 rounded-lg inline-flex items-center gap-2 text-xs font-semibold shadow-sm transition-all active:scale-95 ${
                    groundingEnabled
                      ? 'bg-[#153B25] hover:bg-[#1B4B2F] text-[#4ADE80] border border-[#22C55E]/60 hover:border-[#22C55E]'
                      : 'bg-[#252A32] hover:bg-[#2F3640] text-[#9AA2AD] hover:text-[#D8DEE4] border border-[#3E4756] hover:border-[#525E72]'
                  }`}
                  title={groundingEnabled ? 'SOP Grounding active: Local RAG knowledge retrieval enabled (click to toggle)' : 'SOP Grounding inactive: Click to enable local knowledge retrieval'}
                  aria-label={groundingEnabled ? 'Disable SOP grounding' : 'Enable SOP grounding'}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={groundingEnabled ? 'text-[#4ADE80]' : 'text-[#A0AAB5]'}>
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                  <span>Grounding</span>
                  <span className={`w-2 h-2 rounded-full ${groundingEnabled ? 'bg-[#3FB950] shadow-[0_0_8px_#3FB950]' : 'bg-[#525E72]'}`} />
                </button>
              )}

              {/* Voice Input (if provided) */}
              {onVoice && (
                <button
                  type="button"
                  onClick={onVoice}
                  className="h-9 w-9 rounded-lg flex items-center justify-center text-[#D8DEE4] hover:text-white bg-[#252A32] hover:bg-[#2F3640] active:bg-[#20252C] border border-[#3E4756] hover:border-[#525E72] shadow-sm transition-all active:scale-95"
                  title="Voice input"
                  aria-label="Voice input"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="22" />
                  </svg>
                </button>
              )}
            </div>

            {/* Right actions: Shortcuts hint & Send button */}
            <div className="flex items-center gap-3">
              <span className="hidden md:inline-flex items-center gap-1.5 text-xs font-mono text-[#8D96A0] select-none font-medium">
                <span className="px-1.5 py-0.5 rounded bg-[#252A32] border border-[#3E4756] text-[#C4C9D0]">↵</span>
                <span>send</span>
              </span>

              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                className={`
                  w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-150 shadow-md
                  ${canSend
                    ? 'bg-[#3E7CA6] hover:bg-[#4E97C9] active:bg-[#346E94] text-white border border-[#64B5F6]/60 shadow-[0_0_14px_rgba(62,124,166,0.45)] hover:scale-105 active:scale-95 cursor-pointer'
                    : 'bg-[#242A32] text-[#636C78] border border-[#3E4756] opacity-70 cursor-not-allowed'
                  }
                `}
                title={canSend ? 'Send prompt (Enter)' : disabled ? 'Execution in progress' : 'Type a prompt or attach files'}
                aria-label="Send prompt"
              >
                {disabled ? (
                  <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={canSend ? "text-white" : "text-[#76808E]"}>
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
