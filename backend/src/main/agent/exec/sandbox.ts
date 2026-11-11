import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise } from "quickjs-emscripten";
import type { ReadFacade } from "./facade.js";
import type { ExecOutcome } from "./exec-policy.js";
import type { ExecutedToolOutput } from "../tool-dispatcher.js";
import { SANDBOX_PRELUDE_CODE } from "./sandbox-prelude.js";
import { smartTruncate } from "./smart-truncate.js";

export interface SandboxedScriptOptions {
  timeoutMs?: number;
  maxMemoryBytes?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
}

export interface SandboxedScriptResult {
  ok: boolean;
  output: string;
  error?: ExecOutcome["error"];
  escalated?: boolean;
  calledText?: boolean;
  toolCalls: ExecutedToolOutput[];
  durationMs: number;
  newSourceDigests: string[];
}

function toQuickJSValue(vm: QuickJSContext, value: unknown) {
  const serialized = JSON.stringify(value ?? null);
  const jsonStr = vm.newString(serialized);
  const jsonGlobal = vm.getProp(vm.global, "JSON");
  const parseFn = vm.getProp(jsonGlobal, "parse");
  const parsed = vm.callFunction(parseFn, jsonGlobal, jsonStr);
  jsonStr.dispose();
  jsonGlobal.dispose();
  parseFn.dispose();
  if (parsed.error) {
    parsed.error.dispose();
    return vm.undefined;
  }
  return parsed.value;
}

export function cleanScriptCode(code: string): string {
  let cleaned = code.trim();
  // Strip ES module imports (e.g. import { listDir } from 'tools';)
  cleaned = cleaned.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, "");
  // Strip CommonJS require (e.g. const { listDir } = require('tools');)
  cleaned = cleaned.replace(/^(?:const|let|var)\s+[\s\S]*?=\s*require\([^)]+\);?/gm, "");
  return cleaned.trim();
}

export async function runSandboxedScript(
  rawCode: string,
  facade: ReadFacade,
  options: SandboxedScriptOptions = {},
): Promise<SandboxedScriptResult> {
  const code = cleanScriptCode(rawCode);
  const t0 = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = t0 + timeoutMs;
  const maxMemoryBytes = options.maxMemoryBytes ?? 32 * 1024 * 1024;
  const maxOutputChars = options.maxOutputChars ?? 6000;

  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();
  const deferreds: QuickJSDeferredPromise[] = [];

  const state = {
    textOutput: null as string | null,
    escalated: false,
    escalationReason: undefined as string | undefined,
    runtimeError: null as { message: string; stack?: string } | null,
    isCancelled: false,
    isSettled: false,
  };

  if (options.signal) {
    if (options.signal.aborted) state.isCancelled = true;
    options.signal.addEventListener("abort", () => {
      state.isCancelled = true;
    });
  }

  // Enforce memory and execution deadline
  try {
    vm.runtime.setMemoryLimit(maxMemoryBytes);
  } catch {
    // Memory limit not supported on this variant
  }

  vm.runtime.setInterruptHandler(() => {
    if (state.isCancelled) return true;
    return Date.now() > deadline;
  });

  try {
    // 1. Expose text(...) function with smart truncation
    const textFn = vm.newFunction("text", (valHandle) => {
      let dumped: unknown;
      try {
        dumped = vm.dump(valHandle);
      } catch {
        dumped = "[unserializable value]";
      }
      const truncated = smartTruncate(dumped, { maxChars: maxOutputChars });
      state.textOutput = state.textOutput !== null ? state.textOutput + "\n" + truncated : truncated;
    });
    vm.setProp(vm.global, "text", textFn);
    textFn.dispose();

    // 2. Expose escalate(...) function
    const escalateFn = vm.newFunction("escalate", (reasonHandle) => {
      try {
        state.escalationReason = vm.getString(reasonHandle);
      } catch {
        state.escalationReason = "Model requested escalation to native tools";
      }
      state.escalated = true;
      const err = vm.newError(`Escalated: ${state.escalationReason}`);
      return err;
    });
    vm.setProp(vm.global, "escalate", escalateFn);
    escalateFn.dispose();

    // 3. Expose __reportError host callback for runtime try/catch
    const reportErrorFn = vm.newFunction("__reportError", (msgHandle, stackHandle) => {
      try {
        state.runtimeError = {
          message: vm.getString(msgHandle),
          stack: vm.getString(stackHandle),
        };
      } catch {
        state.runtimeError = { message: "Unknown runtime script error" };
      }
    });
    vm.setProp(vm.global, "__reportError", reportErrorFn);
    reportErrorFn.dispose();

    const scriptSettledFn = vm.newFunction("__scriptSettled", () => {
      state.isSettled = true;
    });
    vm.setProp(vm.global, "__scriptSettled", scriptSettledFn);
    scriptSettledFn.dispose();

    const captureReturnFn = vm.newFunction("__captureReturn", (retHandle) => {
      if (state.textOutput !== null) return;
      try {
        const val = vm.dump(retHandle);
        if (val !== undefined && val !== null) {
          const formatted = typeof val === "object" ? JSON.stringify(val, null, 2) : String(val);
          state.textOutput = smartTruncate(formatted, { maxChars: maxOutputChars });
        }
      } catch {}
    });
    vm.setProp(vm.global, "__captureReturn", captureReturnFn);
    captureReturnFn.dispose();

    // 4. Expose console object with captured logs fallback
    const capturedLogs: string[] = [];
    const consoleObj = vm.newObject();
    const makeLogFn = (level: string) =>
      vm.newFunction(level, (...argHandles) => {
        const parts = argHandles.map((h) => {
          try {
            const v = vm.dump(h);
            return typeof v === "object" ? JSON.stringify(v) : String(v);
          } catch {
            return "[unserializable]";
          }
        });
        capturedLogs.push(parts.join(" "));
      });

    const consoleLog = makeLogFn("log");
    const consoleWarn = makeLogFn("warn");
    const consoleError = makeLogFn("error");
    const consoleInfo = makeLogFn("info");

    vm.setProp(consoleObj, "log", consoleLog);
    vm.setProp(consoleObj, "warn", consoleWarn);
    vm.setProp(consoleObj, "error", consoleError);
    vm.setProp(consoleObj, "info", consoleInfo);
    consoleLog.dispose();
    consoleWarn.dispose();
    consoleError.dispose();
    consoleInfo.dispose();
    vm.setProp(vm.global, "console", consoleObj);
    consoleObj.dispose();

    // 5. Construct tools.* facade object
    const toolsObj = vm.newObject();

    const registerAsyncTool = (
      name: string,
      fn: (...args: any[]) => Promise<any>,
    ) => {
      const toolFn = vm.newFunction(name, (...argHandles) => {
        const jsArgs = argHandles.map((h) => {
          try {
            return vm.dump(h);
          } catch {
            return undefined;
          }
        });

        const deferred = vm.newPromise();
        deferreds.push(deferred);

        (async () => {
          try {
            const res = await fn(...jsArgs);
            if (!vm.alive || !deferred.alive) return;
            const qjsVal = toQuickJSValue(vm, res);
            deferred.resolve(qjsVal);
            try { qjsVal.dispose(); } catch {}
          } catch (err) {
            if (!vm.alive || !deferred.alive) return;
            try {
              const msg = err instanceof Error ? err.message : String(err);
              const errVal = vm.newError(msg);
              deferred.reject(errVal);
              try { errVal.dispose(); } catch {}
            } catch {}
          }
        })().catch(() => {});

        return deferred.handle;
      });

      vm.setProp(toolsObj, name, toolFn);
      // Also expose directly on global so both tools.fn() and fn() work seamlessly
      const globalFn = vm.newFunction(name, (...argHandles) => {
        const jsArgs = argHandles.map((h) => {
          try {
            return vm.dump(h);
          } catch {
            return undefined;
          }
        });

        const deferred = vm.newPromise();
        deferreds.push(deferred);

        (async () => {
          try {
            const res = await fn(...jsArgs);
            if (!vm.alive || !deferred.alive) return;
            const qjsVal = toQuickJSValue(vm, res);
            deferred.resolve(qjsVal);
            try { qjsVal.dispose(); } catch {}
          } catch (err) {
            if (!vm.alive || !deferred.alive) return;
            try {
              const msg = err instanceof Error ? err.message : String(err);
              const errVal = vm.newError(msg);
              deferred.reject(errVal);
              try { errVal.dispose(); } catch {}
            } catch {}
          }
        })().catch(() => {});

        return deferred.handle;
      });
      vm.setProp(vm.global, name, globalFn);
      globalFn.dispose();
      toolFn.dispose();
    };

    registerAsyncTool("readFile", (path, opts) => facade.readFile(path, opts));
    registerAsyncTool("search", (query, opts) => facade.search(query, opts));
    registerAsyncTool("listDir", (path, opts) => facade.listDir(path, opts));
    registerAsyncTool("readInput", (id, opts) => facade.readInput(id, opts));
    registerAsyncTool("extractDocument", (fn, opts) => facade.extractDocument(fn, opts));
    registerAsyncTool("retrieveKnowledge", (q) => facade.retrieveKnowledge(q));
    registerAsyncTool("result", (id, opts) => facade.result(id, opts));
    registerAsyncTool("symbols", (path) => facade.symbols ? facade.symbols(path) : Promise.resolve([]));
    registerAsyncTool("definition", (name, opts) => facade.definition ? facade.definition(name, opts) : Promise.resolve({ matches: [], indexComplete: true }));
    registerAsyncTool("references", (name, opts) => facade.references ? facade.references(name, opts) : Promise.resolve({ matches: [], precision: "workspace-wide" as const, indexComplete: true }));
    registerAsyncTool("repoMap", (opts) => facade.repoMap ? facade.repoMap(opts) : Promise.resolve({ map: "", totalFiles: 0, indexComplete: true }));
    registerAsyncTool("searchCode", (query, opts) => facade.searchCode ? facade.searchCode(query, opts) : Promise.resolve({ results: [], indexComplete: true }));

    vm.setProp(vm.global, "tools", toolsObj);
    toolsObj.dispose();

    // 5. Inject built-in analysis and data prelude utilities
    const preludeRes = vm.evalCode(SANDBOX_PRELUDE_CODE);
    if (preludeRes.error) {
      preludeRes.error.dispose();
    } else {
      preludeRes.value.dispose();
    }

    // 5.5 Normalize un-awaited top-level async invocations and IIFEs
    let normalizedCode = code;
    normalizedCode = normalizedCode.replace(/(?<!await\s+)(\(\s*async\s*(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*|\s*function\s*\(?[^)]*\)?)\s*=>|\(\s*async\s+function\b)/g, 'await $1');
    const asyncFns = [...normalizedCode.matchAll(/async\s+function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g)].map((m) => m[1]);
    for (const fn of asyncFns) {
      normalizedCode = normalizedCode.replace(new RegExp(`(?<!await\\s+|function\\s+)\\b(${fn})\\s*\\(`, 'g'), 'await $1(');
    }

    // Return last top-level expression so that returned values/summaries are captured
    const codeLines = normalizedCode.split('\n');
    let lastIdx = codeLines.length - 1;
    while (lastIdx >= 0 && !codeLines[lastIdx].trim()) lastIdx--;
    if (lastIdx >= 0) {
      const lastLine = codeLines[lastIdx].trim();
      const reservedKeywords = /^(?:return|const|let|var|function|async\s+function|class|for|while|if|else|try|catch|finally|switch|case|break|continue|throw|import|export)\b/;
      const isOnlyClosingTokens = /^\s*[})\]]+;?\s*$/.test(lastLine);
      if (!/\btext\s*\(/.test(normalizedCode) && !reservedKeywords.test(lastLine) && !isOnlyClosingTokens && !lastLine.endsWith('{') && !lastLine.endsWith('}')) {
        codeLines[lastIdx] = codeLines[lastIdx].replace(/^(\s*)(?!return\b)/, '$1return ');
        normalizedCode = codeLines.join('\n');
      }
    }

    // 6. Wrap script in async IIFE and execute
    const wrappedCode = `(async () => {
  const __ret = await (async () => {
${normalizedCode}
  })();
  if (__ret !== undefined) {
    __captureReturn(__ret);
  }
})().then(() => {
  __scriptSettled();
}).catch(__err => {
  __reportError(__err && __err.message ? __err.message : String(__err), __err && __err.stack ? __err.stack : "");
});`;

    const evalRes = vm.evalCode(wrappedCode);
    if (evalRes.error) {
      const errDump = vm.dump(evalRes.error) as { message?: string; line?: number } | string;
      evalRes.error.dispose();
      const message = typeof errDump === "object" ? errDump.message || "Syntax error" : String(errDump);
      const line = typeof errDump === "object" && typeof errDump.line === "number" ? errDump.line : undefined;
      return {
        ok: false,
        output: "",
        error: { kind: "syntax", message, ...(line !== undefined ? { line } : {}) },
        toolCalls: facade.getExecutedTools(),
        durationMs: Date.now() - t0,
        newSourceDigests: facade.getDiscoveredDigests(),
      };
    } else {
      evalRes.value.dispose();
    }

    // 6. Pump the QuickJS event loop until script settles or deadline hits
    while (Date.now() < deadline && !state.isCancelled && !state.escalated && !state.runtimeError) {
      try {
        vm.runtime.executePendingJobs();
      } catch {}
      if ((state.isSettled || state.textOutput !== null) && !vm.runtime.hasPendingJob()) {
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }

    // Final drain of jobs
    try {
      vm.runtime.executePendingJobs();
    } catch {
      // Ignore drain exceptions if timed out
    }

    const durationMs = Date.now() - t0;

    if (state.isCancelled) {
      return {
        ok: false,
        output: state.textOutput || "",
        error: { kind: "timeout", message: "Script cancelled by runtime signal." },
        toolCalls: facade.getExecutedTools(),
        durationMs,
        newSourceDigests: facade.getDiscoveredDigests(),
      };
    }

    if (Date.now() >= deadline || state.runtimeError?.message === "interrupted") {
      return {
        ok: false,
        output: state.textOutput || "",
        error: { kind: "timeout", message: `Script execution timed out (exceeded ${timeoutMs}ms).` },
        toolCalls: facade.getExecutedTools(),
        durationMs,
        newSourceDigests: facade.getDiscoveredDigests(),
      };
    }

    if (state.escalated) {
      return {
        ok: false,
        output: state.textOutput || "",
        error: { kind: "escalated", message: state.escalationReason || "Model requested escalation." },
        escalated: true,
        toolCalls: facade.getExecutedTools(),
        durationMs,
        newSourceDigests: facade.getDiscoveredDigests(),
      };
    }

    if (state.runtimeError) {
      return {
        ok: false,
        output: state.textOutput || "",
        error: { kind: "runtime", message: state.runtimeError.message },
        toolCalls: facade.getExecutedTools(),
        durationMs,
        newSourceDigests: facade.getDiscoveredDigests(),
      };
    }

    const fallbackLogOutput = capturedLogs.length > 0 ? capturedLogs.join("\n").slice(0, 6000) : "";
    return {
      ok: true,
      output: state.textOutput || fallbackLogOutput || "Script executed with no text(...) output.",
      calledText: state.textOutput !== null || capturedLogs.length > 0,
      toolCalls: facade.getExecutedTools(),
      durationMs,
      newSourceDigests: facade.getDiscoveredDigests(),
    };
  } finally {
    for (const d of deferreds) {
      try {
        d.dispose();
      } catch {}
    }
    try {
      vm.runtime.executePendingJobs();
    } catch {}
    try {
      vm.dispose();
    } catch {}
  }
}
