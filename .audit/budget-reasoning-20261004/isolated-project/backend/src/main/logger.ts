// Structured console logger for clean, readable terminal debugging output.

const isColorSupported =
  !process.env.NO_COLOR &&
  (Boolean(process.stdout?.isTTY) || process.env.FORCE_COLOR === "1" || process.env.TERM !== "dumb");

export const c = {
  reset: isColorSupported ? "\x1b[0m" : "",
  bold: isColorSupported ? "\x1b[1m" : "",
  dim: isColorSupported ? "\x1b[2m" : "",
  cyan: isColorSupported ? "\x1b[36m" : "",
  green: isColorSupported ? "\x1b[32m" : "",
  yellow: isColorSupported ? "\x1b[33m" : "",
  red: isColorSupported ? "\x1b[31m" : "",
  blue: isColorSupported ? "\x1b[34m" : "",
  magenta: isColorSupported ? "\x1b[35m" : "",
  gray: isColorSupported ? "\x1b[90m" : "",
};

export function logModelRequest(req: {
  taskType: string;
  modelId: string;
  providerModel: string;
  requestId: string;
  maxTokens: number;
  temperature: number;
  userPromptPreview?: string;
}): void {
  const shortId = req.requestId.slice(0, 8);
  const promptSnippet = req.userPromptPreview
    ? req.userPromptPreview.replace(/[\r\n\t]+/g, " ").trim().slice(0, 100)
    : "";

  console.log(
    `\n${c.blue}┌─ [AI Request: ${req.taskType.toUpperCase()}]${c.reset} ${c.dim}(req:${shortId})${c.reset}\n` +
    `${c.blue}│${c.reset} Model:   ${c.bold}${req.providerModel}${c.reset} (${req.modelId})\n` +
    `${c.blue}│${c.reset} Params:  max_tokens=${req.maxTokens} │ temp=${req.temperature}\n` +
    (promptSnippet ? `${c.blue}│${c.reset} Prompt:  ${c.dim}"${promptSnippet}${promptSnippet.length >= 100 ? "..." : ""}"${c.reset}\n` : "") +
    `${c.blue}└─${"─".repeat(54)}${c.reset}`
  );
}

export function logModelResponse(res: {
  taskType: string;
  requestId: string;
  status: number;
  latencyMs: number;
  finishReason?: string;
  chars?: number;
}): void {
  const shortId = res.requestId.slice(0, 8);
  const ok = res.status >= 200 && res.status < 300;
  const statusStr = ok
    ? `${c.green}HTTP ${res.status}${c.reset}`
    : `${c.red}HTTP ${res.status}${c.reset}`;

  console.log(
    `${c.cyan}┌─ [AI Response: ${res.taskType.toUpperCase()}]${c.reset} ${c.dim}(req:${shortId})${c.reset}\n` +
    `${c.cyan}│${c.reset} Status:  ${statusStr} in ${c.bold}${res.latencyMs}ms${c.reset} (finish: ${res.finishReason ?? "stop"}${res.chars ? `, ${res.chars} chars` : ""})\n` +
    `${c.cyan}└─${"─".repeat(54)}${c.reset}`
  );
}

export function logGeneratedCode(code: {
  filename: string;
  source: string;
  outputMode?: string;
  artifactKind?: string;
  artifactFilename?: string;
  expectedResult?: string;
}): void {
  const lines = code.source.trim().split("\n");
  const header = `${c.cyan}┌── ${c.bold}[Generated Script: ${code.filename}]${c.reset} ${c.cyan}${"─".repeat(Math.max(4, 52 - code.filename.length))}${c.reset}`;
  const formattedLines = lines.map((line, idx) => {
    const num = String(idx + 1).padStart(3, " ");
    return `${c.cyan}│${c.reset} ${c.gray}${num} │${c.reset} ${line}`;
  });

  const parts = [header, ...formattedLines];

  parts.push(`${c.cyan}├── Details ${"─".repeat(46)}${c.reset}`);
  parts.push(`${c.cyan}│${c.reset}   Output Mode: ${c.bold}${code.outputMode ?? "chat"}${c.reset}`);
  if (code.artifactKind) {
    parts.push(`${c.cyan}│${c.reset}   Artifact:    ${c.green}${code.artifactKind}${c.reset}${code.artifactFilename ? ` -> ${code.artifactFilename}` : ""}`);
  }
  if (code.expectedResult) {
    parts.push(`${c.cyan}│${c.reset}   Expected:    ${c.dim}${code.expectedResult.slice(0, 100)}${c.reset}`);
  }
  parts.push(`${c.cyan}└──${"─".repeat(56)}${c.reset}`);

  console.log(parts.join("\n"));
}

export function logModelSummary(summary: string, verified?: boolean): void {
  const lines = summary.trim().split("\n");
  const parts = [
    `${c.cyan}┌── [Model Summary] ${verified !== undefined ? (verified ? `${c.green}(verified)` : `${c.yellow}(unverified)`) : ""}${"─".repeat(36)}${c.reset}`,
  ];
  for (const l of lines.slice(0, 12)) {
    parts.push(`${c.cyan}│${c.reset} ${l}`);
  }
  if (lines.length > 12) {
    parts.push(`${c.cyan}│${c.reset} ${c.dim}... (${lines.length - 12} more lines)${c.reset}`);
  }
  parts.push(`${c.cyan}└──${"─".repeat(56)}${c.reset}`);
  console.log(parts.join("\n"));
}

export function logVisionFindings(findings: Array<{ title: string; value?: string; confidence?: string }>): void {
  const parts = [
    `${c.cyan}┌── [Vision Findings: ${findings.length} item(s)] ${"─".repeat(34)}${c.reset}`,
  ];
  for (let i = 0; i < findings.length && i < 8; i++) {
    const f = findings[i]!;
    const val = f.value ? `: ${f.value}` : "";
    const conf = f.confidence ? ` ${c.dim}(${f.confidence})${c.reset}` : "";
    parts.push(`${c.cyan}│${c.reset} • ${c.bold}${f.title}${c.reset}${val}${conf}`);
  }
  if (findings.length > 8) {
    parts.push(`${c.cyan}│${c.reset} ${c.dim}... (${findings.length - 8} more findings)${c.reset}`);
  }
  parts.push(`${c.cyan}└──${"─".repeat(56)}${c.reset}`);
  console.log(parts.join("\n"));
}

export function logPythonExecution(exec: {
  exitCode: number;
  durationMs: number;
  inputFiles: string[];
  outputFiles: string[];
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}): void {
  const success = exec.exitCode === 0 && !exec.timedOut;
  const border = success ? c.green : c.red;
  const statusStr = success
    ? `${c.green}✔ SUCCESS${c.reset} (exit 0 in ${exec.durationMs}ms)`
    : `${c.red}✖ FAILED${c.reset} (exit ${exec.exitCode} in ${exec.durationMs}ms${exec.timedOut ? " TIMED OUT" : ""})`;

  const lines = [
    `${border}┌── [Python Runner] ${statusStr}${border}${"─".repeat(24)}${c.reset}`,
    `${border}│${c.reset} Inputs:  ${exec.inputFiles.join(", ") || "none"}`,
  ];
  if (exec.outputFiles.length) {
    lines.push(`${border}│${c.reset} Outputs: ${c.bold}${c.green}${exec.outputFiles.join(", ")}${c.reset}`);
  }
  if (exec.stdout?.trim()) {
    lines.push(`${border}├── Stdout ${"─".repeat(46)}${c.reset}`);
    for (const l of exec.stdout.trim().split("\n").slice(0, 15)) {
      lines.push(`${border}│${c.reset}   ${l}`);
    }
  }
  if (exec.stderr?.trim()) {
    lines.push(`${border}├── Stderr ${"─".repeat(46)}${c.reset}`);
    for (const l of exec.stderr.trim().split("\n").slice(0, 15)) {
      lines.push(`${border}│${c.reset}   ${c.red}${l}${c.reset}`);
    }
  }
  lines.push(`${border}└──${"─".repeat(56)}${c.reset}`);
  console.log(lines.join("\n"));
}

export function logScriptRepair(attempt: number, maxAttempts: number, errorSnippet: string): void {
  const firstLine = errorSnippet.split("\n")[0] || errorSnippet;
  console.log(
    `${c.yellow}┌── [Auto-Repair] Python Error Detected (attempt ${attempt}/${maxAttempts}) ───${c.reset}\n` +
    `${c.yellow}│${c.reset} Error:  ${c.red}${firstLine.slice(0, 80)}${c.reset}\n` +
    `${c.yellow}│${c.reset} Action: Feeding error back to code model for automatic script repair...\n` +
    `${c.yellow}└──${"─".repeat(56)}${c.reset}`
  );
}

export function logArtifactReady(artifact: {
  filename: string;
  kind: string;
  relativePath: string;
  sizeBytes: number;
}): void {
  const sizeKb = (artifact.sizeBytes / 1024).toFixed(1);
  console.log(
    `${c.green}┌── [Artifact Ready: ${artifact.kind.toUpperCase()}] ${"─".repeat(36)}${c.reset}\n` +
    `${c.green}│${c.reset} File:     ${c.bold}${artifact.filename}${c.reset} (${sizeKb} KB)\n` +
    `${c.green}│${c.reset} Location: ${c.dim}${artifact.relativePath}${c.reset}\n` +
    `${c.green}└──${"─".repeat(56)}${c.reset}`
  );
}

export function logRunTransition(runId: string, state: string, detail?: string): void {
  const shortRun = runId.slice(0, 8);
  console.log(
    `${c.magenta}[run:${shortRun}]${c.reset} ➜ ${c.bold}${state}${c.reset}${detail ? ` ${c.dim}(${detail})${c.reset}` : ""}`
  );
}

export function logGatewayError(request: { requestId: string; taskType: string }, message: string, detail?: string): void {
  const shortId = request.requestId.slice(0, 8);
  console.error(
    `${c.red}┌── [AI Gateway Error: ${request.taskType.toUpperCase()}] (req:${shortId}) ${"─".repeat(24)}${c.reset}\n` +
    `${c.red}│${c.reset} Message: ${message}\n` +
    (detail ? `${c.red}│${c.reset} Detail:  ${c.dim}${detail.slice(0, 200)}${c.reset}\n` : "") +
    `${c.red}└──${"─".repeat(56)}${c.reset}`
  );
}

export function logHarnessToolCall(call: {
  tool: string;
  args?: Record<string, unknown>;
  runId?: string;
  workspaceRoot?: string;
}): void {
  const border = c.yellow;
  const toolName = call.tool;
  const header = `${border}┌── [Tool Executing: ${c.bold}${toolName}${c.reset}${border}] ${"─".repeat(Math.max(4, 44 - toolName.length))}${c.reset}`;
  const lines: string[] = [header];

  if (call.tool === "run_command" && call.args?.command) {
    lines.push(`${border}│${c.reset} Command:  ${c.bold}${c.green}${call.args.command}${c.reset}`);
    if (call.workspaceRoot) {
      lines.push(`${border}│${c.reset} CWD:      ${c.dim}${call.workspaceRoot}${c.reset}`);
    }
  } else if (call.tool === "write_file" && call.args?.path) {
    const contentLen = typeof call.args.content === "string" ? call.args.content.length : 0;
    lines.push(`${border}│${c.reset} Target:   ${c.bold}${call.args.path}${c.reset} (${contentLen} chars)`);
  } else if (call.tool === "read_file" && call.args?.path) {
    lines.push(`${border}│${c.reset} Reading:  ${c.bold}${call.args.path}${c.reset}`);
  } else if (call.tool === "list_dir") {
    lines.push(`${border}│${c.reset} Path:     ${c.bold}${call.args?.path ?? "."}${c.reset}`);
  } else if (call.tool === "search") {
    lines.push(`${border}│${c.reset} Query:    "${c.bold}${call.args?.query ?? ""}${c.reset}" in ${call.args?.path ?? "."}`);
  } else if (call.args) {
    lines.push(`${border}│${c.reset} Args:     ${c.dim}${JSON.stringify(call.args)}${c.reset}`);
  }

  lines.push(`${border}└──${"─".repeat(56)}${c.reset}`);
  console.log(lines.join("\n"));
}

export function logHarnessToolResult(
  call: {
    tool: string;
    args?: Record<string, unknown>;
  },
  result: {
    tool: string;
    result: unknown;
  },
): void {
  const toolName = call.tool;
  if (toolName === "run_command") {
    const cmdRes = result.result as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      timedOut?: boolean;
      durationMs?: number;
    };
    const success = (cmdRes.exitCode ?? 0) === 0 && !cmdRes.timedOut;
    const border = success ? c.green : c.red;
    const statusStr = success
      ? `${c.green}✔ SUCCESS${c.reset} (exit 0 in ${cmdRes.durationMs ?? 0}ms)`
      : `${c.red}✖ FAILED${c.reset} (exit ${cmdRes.exitCode ?? 1} in ${cmdRes.durationMs ?? 0}ms${cmdRes.timedOut ? " TIMED OUT" : ""})`;

    const lines = [
      `${border}┌── [Command Output] ${statusStr} ${border}${"─".repeat(Math.max(4, 24))}${c.reset}`,
    ];
    if (cmdRes.stdout?.trim()) {
      lines.push(`${border}├── Stdout ${"─".repeat(46)}${c.reset}`);
      for (const l of cmdRes.stdout.trim().split("\n").slice(0, 15)) {
        lines.push(`${border}│${c.reset}   ${l}`);
      }
      if (cmdRes.stdout.trim().split("\n").length > 15) {
        lines.push(`${border}│${c.reset}   ${c.dim}... (${cmdRes.stdout.trim().split("\n").length - 15} more lines)${c.reset}`);
      }
    }
    if (cmdRes.stderr?.trim()) {
      lines.push(`${border}├── Stderr ${"─".repeat(46)}${c.reset}`);
      for (const l of cmdRes.stderr.trim().split("\n").slice(0, 15)) {
        lines.push(`${border}│${c.reset}   ${c.red}${l}${c.reset}`);
      }
    }
    if (!cmdRes.stdout?.trim() && !cmdRes.stderr?.trim()) {
      lines.push(`${border}│${c.reset}   ${c.dim}(no output emitted)${c.reset}`);
    }
    lines.push(`${border}└──${"─".repeat(56)}${c.reset}`);
    console.log(lines.join("\n"));
  } else if (toolName === "write_file") {
    const border = c.green;
    console.log(
      `${border}┌── [Tool Result: write_file] ✔ SUCCESS ${"─".repeat(24)}${c.reset}\n` +
      `${border}│${c.reset} File:   ${c.bold}${call.args?.path}${c.reset}\n` +
      `${border}│${c.reset} Status: Written to workspace disk\n` +
      `${border}└──${"─".repeat(56)}${c.reset}`
    );
  } else if (toolName === "read_file") {
    const border = c.cyan;
    const content = typeof result.result === "string" ? result.result : "";
    const linesCount = content.split("\n").length;
    console.log(
      `${border}┌── [Tool Result: read_file] ✔ ${"─".repeat(30)}${c.reset}\n` +
      `${border}│${c.reset} File:   ${c.bold}${call.args?.path}${c.reset} (${linesCount} lines, ${content.length} chars)\n` +
      `${border}└──${"─".repeat(56)}${c.reset}`
    );
  } else if (toolName === "list_dir") {
    const border = c.cyan;
    const entries = Array.isArray(result.result) ? result.result : [];
    const names = entries.slice(0, 8).map((e: any) => e.name).join(", ");
    console.log(
      `${border}┌── [Tool Result: list_dir] ✔ (${entries.length} items) ${"─".repeat(24)}${c.reset}\n` +
      `${border}│${c.reset} Entries: ${c.dim}${names}${entries.length > 8 ? "..." : ""}${c.reset}\n` +
      `${border}└──${"─".repeat(56)}${c.reset}`
    );
  } else if (toolName === "search") {
    const border = c.cyan;
    const matches = Array.isArray(result.result) ? result.result : [];
    console.log(
      `${border}┌── [Tool Result: search] ✔ (${matches.length} matches) ${"─".repeat(24)}${c.reset}\n` +
      `${border}└──${"─".repeat(56)}${c.reset}`
    );
  }
}
