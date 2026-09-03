type Model = { id: string; name: string; desc: string };

type Props = {
  open: boolean;
  pos: { top: number; left: number; width: number };
  models: Model[];
  selected: Model;
  onSelect: (m: Model) => void;
  onClose: () => void;
};

export default function ModelDropdown({ open, pos, models, selected, onSelect, onClose }: Props) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} style={{ background: 'transparent' }} />
      <div className="fixed z-40 neu-dropdown p-1.5 overflow-y-auto" style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: '13rem' }}>
        {models.map((m) => (
          <button
            key={m.id}
            onClick={() => onSelect(m)}
            className={`w-full text-left p-3 rounded-xl flex items-center justify-between ${selected.id === m.id ? 'neu-pressed' : 'hover:brightness-110'}`}
            style={{ transition: 'all 0.35s cubic-bezier(0.16,1,0.3,1)' }}
          >
            <div>
              <div className="text-sm font-medium">{m.name}</div>
              <div className="text-xs opacity-50">{m.desc}</div>
            </div>
            {selected.id === m.id && <span className="w-2 h-2 rounded-full bg-white/70 shrink-0" />}
          </button>
        ))}
      </div>
    </>
  );
}
