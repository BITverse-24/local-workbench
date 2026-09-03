import { useRef } from 'react';

type Props = {
  open: boolean;
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  files: File[];
  setFiles: (fn: (prev: File[]) => File[]) => void;
  onClose: () => void;
};

export default function UploadModal({ open, dragOver, setDragOver, files, setFiles, onClose }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[480px] neu-panel p-6 animate-apple-scaleIn" style={{ background: '#1F1F1F' }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Upload files</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-full neu-button grid place-items-center text-xs">✕</button>
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = Array.from(e.dataTransfer.files); if (f.length) setFiles((prev) => [...prev, ...f]); }}
          onClick={() => fileInputRef.current?.click()}
          className={`w-full rounded-2xl border-2 border-dashed p-8 flex flex-col items-center justify-center gap-3 cursor-pointer transition ${dragOver ? 'neu-pressed' : 'neu-card hover:brightness-110'}`}
          style={{ borderColor: dragOver ? 'rgba(255,255,255,0.18)' : '#2A2A2A', transition: 'all 0.3s cubic-bezier(0.16,1,0.3,1)' }}
        >
          <div className="w-12 h-12 rounded-full neu-pressed grid place-items-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">Drop files here</p>
            <p className="text-xs opacity-50 mt-1">or click to browse • PDF, image, doc up to 10MB</p>
          </div>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) setFiles((prev) => [...prev, ...Array.from(e.target.files!)]); }} />
        </div>
        {files.length > 0 && (
          <div className="mt-4 space-y-2 max-h-32 overflow-y-auto">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} className="flex items-center justify-between p-2.5 rounded-xl neu-card text-sm">
                <span className="truncate pr-2">{f.name} <span className="opacity-40">• {(f.size / 1024).toFixed(1)} KB</span></span>
                <button onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))} className="w-6 h-6 rounded-full neu-button grid place-items-center text-xs shrink-0">✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 mt-6">
          <button onClick={() => { setFiles(() => []); onClose(); }} className="flex-1 py-2.5 neu-button text-sm">Cancel</button>
          <button onClick={onClose} disabled={files.length === 0} className="flex-1 py-2.5 neu-button-primary text-sm disabled:opacity-40 disabled:cursor-not-allowed">Upload {files.length > 0 ? `(${files.length})` : ''}</button>
        </div>
      </div>
    </div>
  );
}
