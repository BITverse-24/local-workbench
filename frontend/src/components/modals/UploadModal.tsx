import { useRef, useState, useEffect } from 'react';

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

type Props = {
  open: boolean;
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  files: File[];
  setFiles: (fn: (prev: File[]) => File[]) => void;
  onClose: () => void;
  onConfirm?: () => void;
};

export default function UploadModal({ open, dragOver, setDragOver, files, setFiles, onClose, onConfirm }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = (incoming: File[]) => {
    const tooBig = incoming.filter((f) => f.size > MAX_SIZE);
    const valid = incoming.filter((f) => f.size <= MAX_SIZE);
    if (tooBig.length) {
      const names = tooBig.map((f) => `${f.name} (${(f.size / (1024 * 1024)).toFixed(1)}MB)`).join(', ');
      setError(`File too big: ${names} — limit is 10MB`);
      setTimeout(() => setError(null), 4000);
    } else {
      setError(null);
    }
    if (valid.length) setFiles((prev) => [...prev, ...valid]);
  };

  useEffect(() => { if (!open) setError(null); }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-[480px] rounded-[var(--radius-md)] neu-panel p-6 bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Upload files</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(Array.from(e.dataTransfer.files)); }}
          onClick={() => fileInputRef.current?.click()}
          className={`w-full rounded-[var(--radius-sm)] border-2 border-dashed p-6 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors ${dragOver ? 'bg-[var(--bg-surface-raised)] border-[var(--accent)]' : 'bg-[var(--bg-surface-raised)] border-[var(--border-muted)] hover:border-[var(--border-subtle)]'}`}
        >
          <div className="w-10 h-10 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] border border-[var(--border-subtle)] grid place-items-center text-[var(--text-secondary)]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-xs font-medium text-[var(--text-primary)]">Drop files here</p>
            <p className="text-[11px] text-[var(--text-tertiary)] mt-1">or click to browse • PDF, image, doc up to 10MB</p>
          </div>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) handleFiles(Array.from(e.target.files)); }} />
        </div>
        {error && (
          <div className="mt-3 p-2.5 rounded-[var(--radius-sm)] neu-card border border-[var(--status-error)]/40 text-xs text-[var(--status-error)] flex items-center gap-2">
            <span className="flex-1 leading-tight">{error}</span>
            <button onClick={() => setError(null)} className="w-5 h-5 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs shrink-0">✕</button>
          </div>
        )}
        {files.length > 0 && (
          <div className="mt-4 space-y-1.5 max-h-32 overflow-y-auto">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} className="flex items-center justify-between p-2 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-xs">
                <span className="truncate pr-2 text-[var(--text-primary)]">{f.name} <span className="text-[var(--text-tertiary)] font-mono">• {(f.size / 1024).toFixed(1)} KB</span></span>
                <button onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))} className="w-5 h-5 rounded-[var(--radius-sm)] neu-button grid place-items-center text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0">✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2.5 mt-5">
          <button onClick={() => { setFiles(() => []); onClose(); }} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
          <button onClick={() => (onConfirm ? onConfirm() : onClose())} disabled={files.length === 0} className="flex-1 h-10 rounded-[var(--radius-sm)] neu-button-primary text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed">Attach {files.length > 0 ? `(${files.length})` : ''}</button>
        </div>
      </div>
    </div>
  );
}
 