type Props = {
  recovery: NonNullable<RunSnapshot["recovery"]>;
  artifacts: ArtifactRef[];
  busy: boolean;
  onResume: () => void;
  onRefresh: () => void;
  onNewAttempt?: () => void;
};

export default function RunRecoveryCard({ recovery, artifacts, busy, onResume, onRefresh, onNewAttempt }: Props) {
  return <section aria-label="Task recovery" className="mx-4 mt-3 max-h-[35vh] overflow-auto rounded-lg border border-[var(--status-warning)]/40 bg-[var(--bg-surface)] p-4 text-sm text-[var(--text-secondary)]">
    <h2 className="font-semibold text-[var(--text-primary)]">This task needs another step</h2>
    <p className="mt-1 break-words">{recovery.reason}</p>
    {artifacts.length > 0 && <p className="mt-2">{artifacts.length} saved {artifacts.length === 1 ? "output is" : "outputs are"} available in the conversation.</p>}
    {recovery.completed.length > 0 && <details className="mt-2"><summary>Completed work ({recovery.completed.length})</summary><ul className="mt-1 list-disc pl-5">{recovery.completed.map((label, i) => <li key={i}>{label}</li>)}</ul></details>}
    {recovery.remaining.length > 0 && <details className="mt-2" open><summary>Still to do ({recovery.remaining.length})</summary><ul className="mt-1 list-disc pl-5">{recovery.remaining.map((label, i) => <li key={i}>{label}</li>)}</ul></details>}
    {recovery.workspaceRoot && <p className="mt-2 break-all text-xs">Project folder: {recovery.workspaceRoot}</p>}
    <p className="mt-2 text-xs">Saved work stays available. Resume checks the current inputs and requests any required approval.</p>
    <div className="mt-3 flex flex-wrap gap-3">
      {recovery.canResume && <button disabled={busy} onClick={onResume} className="neu-button-primary rounded px-3 py-2">{busy ? "Resuming…" : recovery.largerGenerationAllowance ? "Resume with larger allowance" : "Resume task"}</button>}
      <button disabled={busy} onClick={onRefresh} className="neu-button rounded px-3 py-2">Check again</button>
      {onNewAttempt && <button disabled={busy} onClick={onNewAttempt} className="neu-button rounded px-3 py-2">Start new attempt</button>}
    </div>
  </section>;
}
