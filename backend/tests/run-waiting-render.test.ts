/// <reference path="../../frontend/src/bridge.d.ts" />
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";

let render: (events: RunEvent[], state?: RunState) => string;
beforeAll(() => {
  const result = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import RunWaitingIndicator from './frontend/src/components/RunWaitingIndicator';
    export const render = (events, state = 'acting') => renderToStaticMarkup(
      <RunWaitingIndicator isRunning runState={state} runEvents={events} onCancel={() => {}} />);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", external: ["react", "react-dom/server"], write: false });
  const module = { exports: {} as { render: typeof render } };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  render = module.exports.render;
});
const checkpoint: TaskProgressEvent = { type: "task_progress", runId: "run", activityId: "review", stage: "post_execution_review", status: "active", target: "corrected.py", assessedChecks: 6, totalChecks: 8 };

it("renders evidence sections and safe filename text with no pass claim or timer", () => {
  const html = render([checkpoint]);
  expect(html).toContain("Checking the executed repair");
  expect(html).toContain("6 of 8 checks assessed");
  expect(html).toContain("Still to check");
  expect(html).toContain("<code");
  expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain("checks passed");
  expect(html).not.toContain("stopwatch");
  expect(html).toContain("break-all");
  const unsafe = render([{ ...checkpoint, target: "<img src=x onerror=alert(1)>" }]);
  expect(unsafe).not.toContain("<img");
  expect(unsafe).toContain("&lt;img");
});

it("pauses the skeleton during approval and preserves the draft preview during generation", () => {
  const paused = render([checkpoint], "awaiting_confirmation");
  expect(paused).toContain("Ready for your review");
  expect(paused).not.toContain("run-skeleton");
  expect(paused).toContain("is-paused");
  const draft = render([{ type: "model_progress", runId: "run", requestId: "draft", modelId: "local", purpose: "chat-result", status: "receiving", channel: "text", outputChars: 20, preview: "A useful live draft." }]);
  expect(draft).toContain("A useful live draft.");
  expect(draft).toContain("Draft in progress");
  expect(draft).not.toContain("run-skeleton");
});
