type Props = {
  artifacts: ArtifactRef[];
  onOpen: (a: ArtifactRef) => void;
  runId?: string;
};

export default function ArtifactPane({ artifacts, onOpen }: Props) {
  if (!artifacts.length) return null;
  return (
    <div className="mx-4 my-2 rounded-xl neu-card p-3">
      <div className="text-[11px] tracking-[0.12em] uppercase opacity-50 mb-2">Artifacts</div>
      <div className="space-y-2">
        {artifacts.map((a) => (
          <div key={a.artifactId} className="flex items-center gap-3 p-2 rounded-xl neu-pressed">
            <span className="w-8 h-8 rounded-lg neu-card grid place-items-center text-[9px] font-bold shrink-0">{a.kind.toUpperCase()}</span>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">{a.filename}</div>
              <div className="text-[10px] opacity-50">{a.relativePath} • {(a.sizeBytes / 1024).toFixed(1)} KB</div>
            </div>
            <button onClick={() => onOpen(a)} className="px-3 py-1.5 rounded-full neu-button text-xs font-medium shrink-0">Open</button>
          </div>
        ))}
      </div>
    </div>
  );
}
