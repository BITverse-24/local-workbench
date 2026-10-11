/// <reference path="../../frontend/src/bridge.d.ts" />
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { beforeAll, expect, it } from "vitest";
let render: (capabilities: ExecutionCapabilities | null, mode: ExecutionMode, error?: string) => string;
beforeAll(() => {
  const bundle = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import ExecutionSupport from './frontend/src/components/ExecutionSupport';
    export const render = (capabilities, mode, error) => renderToStaticMarkup(<ExecutionSupport capabilities={capabilities} mode={mode} error={error} />);
  `, loader: "tsx", resolveDir: process.cwd() }, bundle: true, platform: "node", format: "cjs", external: ["react", "react-dom/server"], write: false });
  const module = { exports: {} as { render: typeof render } };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  render = module.exports.render;
});
const windows: ExecutionCapabilities = { platform: "win32", workspaceCommands: { status: "unavailable", message: "Workspace commands are unavailable on Windows." }, python: { status: "approval_required", message: "No filesystem or network isolation. Approval covers source, dependencies, and inputs." } };
it("shows Windows command limits and Python approval before an Agent task", () => { const html = render(windows, "agent"); expect(html).toContain("unavailable on Windows"); expect(html).toContain("approval required; no OS isolation"); expect(html).toContain("dependencies"); });
it("shows Python approval in Work and keeps command diagnostics in Agent", () => { const html = render(windows, "work"); expect(html).toContain("Python"); expect(html).not.toContain("Workspace commands"); expect(render(windows, "chat")).toBe(""); });
it("shows a failed Linux isolation probe and its prerequisite", () => { const html = render({ ...windows, platform: "linux", workspaceCommands: { status: "unavailable", message: "Install bubblewrap and enable user namespaces. Diagnostic: namespace disabled." } }, "agent"); expect(html).toContain("bubblewrap"); expect(html).toContain("namespace disabled"); });
it("shows loading and failed capability reads", () => { expect(render(null, "work")).toContain("Checking execution support"); expect(render(null, "agent", "Execution support could not be checked.")).toContain("could not be checked"); });
