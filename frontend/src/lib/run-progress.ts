import { assessedCheckLabel, TASK_STAGE_LABELS, taskProgressKey } from "../../../backend/src/shared/task-progress.js";

const TERMINAL_STATES = ["completed", "partial", "failed", "cancelled", "limit_exceeded"];

/** Keep current generation and task snapshots separate from the tool record. */
export function updateRunEvents(events: RunEvent[], event: RunEvent): RunEvent[] {
  if (event.type !== "model_progress" && event.type !== "task_progress") return [...events, event];
  const state = [...events].reverse().find(item => item.type === "run_state" && item.runId === event.runId);
  if (state?.type === "run_state" && TERMINAL_STATES.includes(state.state)) return events;
  if (event.type === "task_progress") {
    const key=taskProgressKey(event);
    return [...events.filter(item => item.type !== "task_progress" || item.runId !== event.runId || (item.activityId !== event.activityId && taskProgressKey(item) !== key)), event];
  }
  const retained = events.filter(item => item.type !== "model_progress" || item.requestId !== event.requestId);
  const snapshots = retained.filter(item => item.type === "model_progress");
  const expired = new Set<RunEvent>(snapshots.slice(0, Math.max(0, snapshots.length - 7)));
  return [...retained.filter(item => !expired.has(item)), event];
}

export type ProgressRow = { label: string; target?: string; detail?: string };
const TOOL_LABELS: Record<string, string> = {
  read_file: "Reading source files", extract_document: "Reading the document", ocr_extract: "Reading the image",
  search: "Searching the workspace", list_dir: "Checking the workspace", write_file: "Saving changes", delete_file: "Removing the file",
  execute_python: "Running the code", run_command: "Running the command", retrieve_knowledge: "Checking reference material",
  retrieve_result: "Reading a stored result", inspect_drawing: "Checking the drawing",
  generate_code: "Preparing the code", generate_text: "Preparing the draft", generate_deliverable: "Building the document",
};
const TOOL_CONFIRMED: Record<string, string> = {
  read_file: "Source read", extract_document: "Document read", ocr_extract: "Image read", write_file: "Changes saved", delete_file: "File removed",
  execute_python: "Execution succeeded", run_command: "Command succeeded", retrieve_knowledge: "Reference search completed",
  retrieve_result: "Stored result read", inspect_drawing: "Drawing inspection finished",
};
const targetFor = (args?: Record<string, unknown>) => {
  const target = args?.filename ?? args?.path;
  return typeof target === "string" ? target.slice(0, 240) : undefined;
};
const boundedRows = (rows: ProgressRow[]) => {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 3);
};

export function getRunProgress(events: RunEvent[], state: RunState | null) {
  const terminal = state !== null && TERMINAL_STATES.includes(state);
  const models = terminal ? [] : events.filter((event): event is ModelProgressEvent =>
    event.type === "model_progress" && (event.status === "waiting" || event.status === "receiving"));
  const progress = models[models.length - 1];
  const taskMap = new Map<string, TaskProgressEvent>();
  const pendingTools = new Map<string, Extract<RunEvent, { type: "tool_call" }>>();
  const calls = new Map<string, Extract<RunEvent, { type: "tool_call" }>>();
  const completedTools: ProgressRow[] = [];
  const saved = new Map<string, ProgressRow>();
  let anonymous = 0;
  for (const event of events) {
    if (event.type === "task_progress") {
      taskMap.delete(event.activityId); taskMap.set(event.activityId, event);
    }
    if (event.type === "tool_call") {
      const id = event.callId ?? `anonymous-${anonymous++}`;
      pendingTools.set(id, event); calls.set(id, event);
    }
    if (event.type === "tool_result") {
      const match = event.callId ?? [...pendingTools].reverse().find(([, call]) => call.tool === event.tool)?.[0];
      const call = match ? calls.get(match) : undefined;
      if (match) pendingTools.delete(match);
      if (event.ok === true && TOOL_CONFIRMED[event.tool]) completedTools.unshift({ label: TOOL_CONFIRMED[event.tool], target: targetFor(call?.args) });
    }
    if (event.type === "artifact_ready") saved.set(event.artifact.artifactId, { label: "File saved", target: event.artifact.filename });
  }
  // Also fold old snapshots, which can contain one activity ID for every retry.
  const latestStages = new Map<string, TaskProgressEvent>();
  for(const item of taskMap.values()){
    const key=taskProgressKey(item);
    latestStages.delete(key);latestStages.set(key,item);
  }
  const tasks = [...latestStages.values()];
  const active = terminal ? [] : tasks.filter(event => event.status === "active");
  const activeTasks = active.filter(event => !active.some(child => child.parentActivityId === event.activityId));
  const task = activeTasks[activeTasks.length - 1];
  const tools = terminal ? [] : [...pendingTools.values()];
  const tool = tools[tools.length - 1];
  const purpose = progress?.purpose ?? "";
  const stage = task ? TASK_STAGE_LABELS[task.stage] : undefined;
  const parentStage = task?.parentActivityId ? taskMap.get(task.parentActivityId)?.stage : undefined;
  const kind = (task?.stage === "correction" && parentStage ? TASK_STAGE_LABELS[parentStage].kind : stage?.kind) ?? (tool?.tool === "execute_python" || tool?.tool === "run_command" || tool?.tool === "generate_code" || purpose === "code-result"
    ? "code" : tool?.tool === "generate_deliverable" || tool?.tool === "generate_text" || purpose === "draft-result" ? "document" : "text");
  let title = "Preparing the response";
  if (task) title = stage!.active;
  else if (tool) title = TOOL_LABELS[tool.tool] ?? "Running the next action";
  else if (state === "classifying" || purpose === "intent_classification" || purpose === "classification") title = "Understanding the request";
  else if (state === "planning") title = "Preparing the next steps";
  else if (progress?.status === "receiving") {
    if (progress.channel === "reasoning") title = "Working through the request";
    else if (progress.channel === "tool_arguments") title = "Preparing the next action";
    else if (progress.channel === "text") title = "Writing the response";
    else if (progress.channel === "structured") title = "Preparing the result";
  }
  let waitingForPages=false;
  for(const event of events){if(event.type==='source_page_selection')waitingForPages=true;else if(event.type==='source_inspection'&&event.stage==='visual')waitingForPages=false;}
  const paused = state === "awaiting_confirmation" || waitingForPages && !terminal;
  if (paused) title = waitingForPages ? "Select pages to inspect" : "Ready for your review";
  const checkpoints = tasks;
  const nowTasks = paused || terminal ? [] : activeTasks.slice(-3).reverse();
  const reviewStages: TaskProgressEvent["stage"][] = ["source_text", "visual_inspection", "source_inspection", "pre_execution_review", "post_execution_review", "source_coverage_review", "result_verification"];
  const summary = {
    confirmed: boundedRows([...saved.values()].reverse().concat(completedTools, checkpoints.filter(item => item.status === "completed" && reviewStages.includes(item.stage)).reverse()
      .map(item => ({ label: TASK_STAGE_LABELS[item.stage].completed, target: item.target, detail: assessedCheckLabel(item) })))),
    now: paused || terminal ? [] : boundedRows(nowTasks.map(item => ({ label: TASK_STAGE_LABELS[item.stage].active, target: item.target, detail: assessedCheckLabel(item) }))
      .concat(tools.filter(call => !activeTasks.some(item => item.parentCallId && item.parentCallId === call.callId)).reverse().map(call => ({ label: TOOL_LABELS[call.tool] ?? "Running the next action", target: targetFor(call.args), detail: undefined })))),
    remaining: boundedRows(checkpoints.filter(item => item.status !== "completed").reverse().map(item => ({ label: TASK_STAGE_LABELS[item.stage].remaining,
      target: nowTasks.includes(item) ? undefined : item.target, detail: nowTasks.includes(item) ? undefined : assessedCheckLabel(item) }))),
  };
  const activityCount = Math.max(activeTasks.length + tools.filter(call => !activeTasks.some(item => item.parentCallId && item.parentCallId === call.callId)).length, models.length);
  return { progress, tool, task, tasks, title, kind, paused, summary,
    additionalTasks: paused ? 0 : Math.max(0, activityCount - 1),
    reasoning: !paused && progress?.status === "receiving" && progress.channel === "reasoning" };
}
