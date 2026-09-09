type Props = {
  open: boolean;
  pos: { top: number; left: number };
  onClose: () => void;
  onUpload: () => void;
  onCamera: () => void;
  onSearch: () => void;
};

export default function PlusDropup({ open, pos, onClose, onUpload, onCamera, onSearch }: Props) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} style={{ background: 'transparent' }} />
      <div className="fixed z-40 neu-dropdown p-1.5 flex flex-col gap-1.5" style={{ left: pos.left, bottom: `calc(100vh - ${pos.top}px + 12px)`, width: 220 }}>
        <button onClick={onUpload} className="w-full text-left p-3 rounded-xl flex items-center gap-3 hover:brightness-110 neu-card" style={{ transition: 'all 0.35s cubic-bezier(0.16,1,0.3,1)' }}>
          <span className="w-8 h-8 rounded-full neu-pressed grid place-items-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <polyline points="9 15 12 12 15 15" />
            </svg>
          </span>
          <div>
            <div className="text-sm font-medium">Upload files</div>
            <div className="text-xs opacity-50">PDF, image, doc</div>
          </div>
        </button>
        <button onClick={onCamera} className="w-full text-left p-3 rounded-xl flex items-center gap-3 hover:brightness-110 neu-card" style={{ transition: 'all 0.35s cubic-bezier(0.16,1,0.3,1)' }}>
          <span className="w-8 h-8 rounded-full neu-pressed grid place-items-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
              <circle cx="12" cy="13" r="3" />
            </svg>
          </span>
          <div>
            <div className="text-sm font-medium">Camera</div>
            <div className="text-xs opacity-50">Take photo</div>
          </div>
        </button>
        <button onClick={onSearch} className="w-full text-left p-3 rounded-xl flex items-center gap-3 hover:brightness-110 neu-card" style={{ transition: 'all 0.35s cubic-bezier(0.16,1,0.3,1)' }}>
          <span className="w-8 h-8 rounded-full neu-pressed grid place-items-center shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="opacity-80">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
          </span>
          <div>
            <div className="text-sm font-medium">Search</div>
            <div className="text-xs opacity-50">Search the web</div>
          </div>
        </button>
      </div>
    </>
  );
}
