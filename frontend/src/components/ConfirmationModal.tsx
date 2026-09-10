type Props = {
  open: boolean;
  action: PendingAction | null;
  runState: RunState | null;
  onApprove: () => void;
  onReject: () => void;
  onClose: () => void;
  busy?: boolean;
};

export default function ConfirmationModal({ open, action, runState, onApprove, onReject, busy = false }: Props) {
  if (!open || !action) return null;
  const expiresIn = (() => {
    const ms = Date.parse(action.expiresAt) - Date.now();
    if (ms <= 0) return "expired";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, "0")} remaining`;
  })();
  const kindLabel =
    action.kind === "generate_docx" ? "DOCX generation" :
    action.kind === "execute_python" ? "Python execution" :
    "XLSX generation";
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 backdrop-blur-[1px] p-4 animate-apple-fade">
      <div className="w-[420px] max-w-full neu-dropdown p-6 animate-apple-scaleIn">
        <div className="text-[11px] tracking-[0.14em] uppercase opacity-50">{kindLabel}</div>
        <h3 className="text-base font-semibold mt-1">{action.prompt}</h3>
        <p className="text-xs opacity-60 mt-2">Run {action.runId.slice(0, 8)} • {runState ?? ""}</p>
        <p className="text-xs opacity-50 mt-1">Expires: {expiresIn}</p>
        <p className="text-xs opacity-50 mt-1">This action requires your approval before the backend proceeds.</p>
        {action.preview && (
          <div className="mt-4 bg-black/10 dark:bg-black/40 rounded border border-black/10 dark:border-white/10 p-3 overflow-x-auto max-h-[200px] overflow-y-auto">
            <pre className="text-xs font-mono whitespace-pre-wrap">{action.preview}</pre>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onReject} disabled={busy} className="px-5 py-2 rounded-full neu-button text-sm font-medium disabled:opacity-40">{busy ? "Working…" : "Reject"}</button>
          <button onClick={onApprove} disabled={busy} className="px-5 py-2 rounded-full neu-button-primary text-sm font-semibold disabled:opacity-40">{busy ? "Working…" : "Approve"}</button>
        </div>
      </div>
    </div>
  );
}
