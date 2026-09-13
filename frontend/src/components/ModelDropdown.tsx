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
      <div className="fixed z-40 rounded-[var(--radius-md)] neu-dropdown p-1 overflow-y-auto border border-[var(--border-subtle)] bg-[var(--bg-surface)]" style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: '13rem' }}>
        {models.map((m) => (
          <button
            key={m.id}
            onClick={() => onSelect(m)}
            className={`w-full text-left p-2 rounded-[var(--radius-sm)] flex items-center justify-between transition-colors ${selected.id === m.id ? 'bg-[var(--bg-surface-raised)] text-[var(--text-primary)]' : 'hover:bg-[var(--bg-surface-raised)] text-[var(--text-secondary)]'}`}
          >
            <div>
              <div className="text-xs font-medium text-[var(--text-primary)]">{m.name}</div>
              <div className="text-[11px] text-[var(--text-tertiary)]">{m.desc}</div>
            </div>
            {selected.id === m.id && <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />}
          </button>
        ))}
      </div>
    </>
  );
}
