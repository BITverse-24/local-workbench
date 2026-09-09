type Props = {
  route: { taskType: string; modelId: string; reason: string } | null;
  state: string | null;
};

export default function RouteBadge({ route, state }: Props) {
  if (!route) return null;
  return (
    <div className="mx-4 mt-2 px-3 py-2 rounded-xl neu-card flex items-center gap-3 text-xs">
      <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse shrink-0" />
      <span className="font-medium">{route.taskType} route</span>
      <span className="opacity-60">{route.modelId}</span>
      <span className="opacity-40 hidden sm:inline">Reason: {route.reason}</span>
      {state && <span className="ml-auto opacity-40">{state}</span>}
    </div>
  );
}
