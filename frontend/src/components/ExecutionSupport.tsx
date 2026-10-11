type Props = { capabilities: ExecutionCapabilities | null; mode?: ExecutionMode; error?: string | null };

export default function ExecutionSupport({ capabilities, mode, error }: Props) {
  if (mode === "chat") return null;
  if (error) return <div role="status" className="text-xs text-[var(--text-secondary)]">{error}</div>;
  if (!capabilities) return <div role="status" className="text-xs text-[var(--text-tertiary)]">Checking execution support…</div>;
  const entries = [
    ...(mode !== "work" ? [{ label: "Workspace commands", capability: capabilities.workspaceCommands }] : []),
    { label: "Python", capability: capabilities.python },
  ];
  return (
    <div aria-label="Execution support" className="space-y-1 text-xs text-[var(--text-secondary)]">
      {entries.map(({ label, capability }) => (
        <div key={label}>
          <span className="font-medium">{label}: {capability.status === "os_isolated" ? "OS isolation available" : capability.status === "approval_required" ? "approval required; no OS isolation" : "unavailable"}.</span>
          {capability.status !== "os_isolated" && <span> {capability.message}</span>}
        </div>
      ))}
    </div>
  );
}
