import AgentExecutionTimeline from "./AgentExecutionTimeline";

type Props = {
  isRunning: boolean;
  runState: RunState | null;
  activeRoute?: { taskType: string; modelId: string; reason: string } | null;
  runEvents?: RunEvent[];
  onCancel?: () => void;
};

export default function RunWaitingIndicator({
  isRunning,
  runState,
  activeRoute,
  runEvents = [],
  onCancel,
}: Props) {
  if (!isRunning) return null;

  return (
    <AgentExecutionTimeline
      isRunning={isRunning}
      runState={runState}
      activeRoute={activeRoute}
      events={runEvents}
      onCancel={onCancel}
      defaultExpanded={true}
      compact={false}
    />
  );
}
