/// <reference path="../../frontend/src/bridge.d.ts" />
import { expect, it } from "vitest";
import { getRunProgress, updateRunEvents } from "../../frontend/src/lib/run-progress.js";
import { RunSessions } from '../../frontend/src/lib/run-sessions.js';

const progress = (requestId: string, channel: ModelProgressEvent["channel"] = "text", status: ModelProgressEvent["status"] = "receiving"): ModelProgressEvent =>
  ({ type: "model_progress", runId: "run", requestId, modelId: "local", purpose: "working_turn", status, channel, outputChars: 20 });

it("replaces transient snapshots and bounds them without losing tool records", () => {
  const tool: RunEvent = { type: "tool_call", runId: "run", callId: "tool", tool: "read_file", summary: "Read source" };
  let events: RunEvent[] = [tool];
  for (let n = 0; n < 100; n++) events = updateRunEvents(events, progress(String(n)));
  expect(events.filter(event => event.type === "model_progress")).toHaveLength(8);
  expect(events).toContain(tool);
  events = updateRunEvents(events, progress("99", "reasoning"));
  expect(events).toHaveLength(9);
  expect(getRunProgress(events, "acting").title).toBe("Reading source files");
  expect(getRunProgress(events, "acting").reasoning).toBe(true);
});

it("keeps each parallel request active until its own response arrives", () => {
  let events = updateRunEvents([], progress("one", "reasoning"));
  events = updateRunEvents(events, progress("two", "tool_arguments"));
  events = updateRunEvents(events, progress("two", "tool_arguments", "received"));
  expect(getRunProgress(events, "acting").progress?.requestId).toBe("one");
  events = updateRunEvents(events, progress("one", "reasoning", "received"));
  expect(getRunProgress(events, "acting").progress).toBeUndefined();
});

it("matches repeated tool names by call ID and shows the unfinished tool", () => {
  const state = getRunProgress([
    { type: "tool_call", runId: "run", callId: "a", tool: "extract_document", summary: "Read first file" },
    { type: "tool_call", runId: "run", callId: "b", tool: "extract_document", summary: "Read second file" },
    { type: "tool_result", runId: "run", callId: "b", tool: "extract_document", summary: "Second file read", ok: true },
  ], "acting");
  expect(state.tool?.callId).toBe("a");
  expect(state.title).toBe("Reading the document");
});

it("stops generation presentation during approval and avoids claiming reasoning for a plain model", () => {
  const events = [progress("one", "text")];
  expect(getRunProgress(events, "acting").title).toBe("Writing the response");
  const paused = getRunProgress(events, "awaiting_confirmation");
  expect(paused.paused).toBe(true);
  expect(paused.title).toBe("Ready for your review");
});

const task = (activityId: string, stage: TaskProgressEvent["stage"], status: TaskProgressEvent["status"] = "active", target?: string): TaskProgressEvent =>
  ({ type: "task_progress", runId: "run", activityId, stage, status, target });

it('updates one review row across retries and replaces old counts and blocker text',()=>{
  let events:RunEvent[]=[];
  for(let attempt=0;attempt<4;attempt++)events=updateRunEvents(events,{
    ...task(`retry-${attempt}`,'post_execution_review','blocked','parser.py'),assessedChecks:attempt,totalChecks:4,reason:'Review response was incomplete.',
  });
  expect(events).toHaveLength(1);
  expect(getRunProgress(events,'acting').tasks).toHaveLength(1);
  events=updateRunEvents(events,{...task('last','post_execution_review','active','parser.py'),assessedChecks:0,totalChecks:5});
  let state=getRunProgress(events,'acting');
  expect(state.tasks).toHaveLength(1);expect(state.task?.reason).toBeUndefined();
  expect(state.summary.now[0].detail).toBe('0 of 5 checks assessed');
  events=updateRunEvents(events,{...task('last','post_execution_review','completed','parser.py'),assessedChecks:5,totalChecks:5});
  state=getRunProgress(events,'acting');
  expect(state.tasks).toHaveLength(1);expect(state.summary.remaining).toEqual([]);
  expect(state.summary.confirmed[0].detail).toBe('5 of 5 checks assessed');
});

it('folds historical retry rows while preserving different files and runs',()=>{
  const old=task('old','post_execution_review','blocked','first.py');
  const latest=task('new','post_execution_review','completed','first.py');
  const other=task('other','post_execution_review','active','second.py');
  const state=getRunProgress([old,latest,other],'acting');
  expect(state.tasks).toEqual([latest,other]);expect(state.summary.remaining).toHaveLength(1);
  const separateRun={...latest,runId:'another-run'};
  expect(updateRunEvents([old,other],separateRun)).toHaveLength(3);
});

it('keeps a compact current stage for background chats',()=>{
  const sessions=new RunSessions();sessions.register('run','chat');
  sessions.record(task('first','post_execution_review','blocked'));
  sessions.record(task('second','post_execution_review','active'));
  sessions.record({...task('second','post_execution_review','active'),assessedChecks:3,totalChecks:4});
  expect(sessions.events.get('run')).toEqual([{...task('second','post_execution_review','active'),assessedChecks:3,totalChecks:4}]);
});

it("keeps explicit stages above model channels and shows reasoning only as secondary activity", () => {
  const state = getRunProgress([task("review", "post_execution_review"), progress("model", "reasoning")], "acting");
  expect(state.title).toBe("Checking the executed repair");
  expect(state.reasoning).toBe(true);
  expect(state.summary.remaining[0].label).toBe("Complete behavior coverage");
  expect(getRunProgress([task("draft", "source_coverage_review"), progress("model", "structured")], "acting").title).toBe("Reviewing draft coverage");
});

it("replaces count snapshots, keeps concurrent stages separate, and counts active tasks once", () => {
  let events: RunEvent[] = [task("one", "post_execution_review", "active", "one.py"), task("two", "post_execution_review", "active", "two.py")];
  events = updateRunEvents(events, { ...task("one", "post_execution_review", "active", "one.py"), assessedChecks: 6, totalChecks: 8 });
  expect(events).toHaveLength(2);
  let state = getRunProgress(events, "acting");
  expect(state.additionalTasks).toBe(1);
  expect(state.summary.now[0].detail).toBe("6 of 8 checks assessed");
  events = updateRunEvents(events, task("one", "post_execution_review", "completed", "one.py"));
  state = getRunProgress(events, "acting");
  expect(state.task?.activityId).toBe("two");
  expect(state.additionalTasks).toBe(0);
});

it("does not count a tool, its nested stage, and its model request as three tasks", () => {
  const state = getRunProgress([
    { type: "tool_call", runId: "run", tool: "generate_text", callId: "tool", summary: "Write draft" },
    { ...task("draft", "draft_generation"), parentCallId: "tool" },
    { ...progress("model"), parentCallId: "tool" },
  ], "acting");
  expect(state.additionalTasks).toBe(0);
  expect(state.summary.now).toHaveLength(1);
});

it("shows saved files and successful execution separately from unfinished behavior checks", () => {
  const state = getRunProgress([
    { type: "tool_call", runId: "run", callId: "execute", tool: "execute_python", summary: "Run repair", args: { filename: "corrected.py" } },
    { type: "tool_result", runId: "run", callId: "execute", tool: "execute_python", summary: "exit 0", ok: true },
    { type: "artifact_ready", runId: "run", artifact: { artifactId: "file", runId: "run", kind: "txt", filename: "corrected.py", relativePath: "output/corrected.py", sizeBytes: 10, createdAt: "now" } },
    { ...task("review", "post_execution_review", "active", "corrected.py"), assessedChecks: 6, totalChecks: 8 },
  ], "acting");
  expect(state.summary.confirmed.map(row => row.label)).toEqual(["File saved", "Execution succeeded"]);
  expect(state.summary.now[0].detail).toBe("6 of 8 checks assessed");
  expect(JSON.stringify(state.summary)).not.toContain("passed");
});

it("pauses approval, ignores late terminal checkpoints, and retains the tool record", () => {
  const events: RunEvent[] = [task("review", "post_execution_review"), progress("one", "reasoning")];
  const paused = getRunProgress(events, "awaiting_confirmation");
  expect(paused.title).toBe("Ready for your review");
  expect(paused.summary.now).toEqual([]);
  expect(paused.reasoning).toBe(false);
  events.push({ type: "run_state", runId: "run", state: "cancelled" });
  expect(updateRunEvents(events, task("review", "post_execution_review", "completed"))).toBe(events);
  expect(updateRunEvents(events, progress("late"))).toBe(events);
  expect(getRunProgress(events, "cancelled").summary.now).toEqual([]);
});

it("limits summary rows and retires older blockers after a completed review of the same target", () => {
  const events: RunEvent[] = Array.from({ length: 6 }, (_, index) => task(`review-${index}`, "source_inspection", "completed", `${index}.py`));
  events.push(task("old", "pre_execution_review", "blocked", "target.py"), task("new", "pre_execution_review", "completed", "target.py"));
  const state = getRunProgress(events, "acting");
  expect(state.summary.confirmed).toHaveLength(3);
  expect(state.summary.remaining).toHaveLength(0);
});

it("does not invent confirmed work from plan steps, failed tools, or missing success flags", () => {
  const state = getRunProgress([
    { type: "plan_step", runId: "run", index: 0, text: "Run validation" },
    { type: "tool_result", runId: "run", tool: "execute_python", summary: "Failed", ok: false },
    { type: "tool_result", runId: "run", tool: "read_file", summary: "Unspecified status" },
  ], "acting");
  expect(state.summary.confirmed).toEqual([]);
});

it("shows a nested correction as the current work, without counting its awaiting parent as another task", () => {
  const state = getRunProgress([
    task("coverage", "source_coverage_review", "active", "report.docx"),
    { ...task("correction", "correction", "active", "report.docx"), parentActivityId: "coverage" },
    progress("model", "structured"),
  ], "acting");
  expect(state.title).toBe("Addressing the review findings");
  expect(state.additionalTasks).toBe(0);
  expect(state.kind).toBe("document");
  expect(state.summary.now).toHaveLength(1);
  expect(state.summary.remaining.some(row => row.label === "Draft coverage")).toBe(true);
});
