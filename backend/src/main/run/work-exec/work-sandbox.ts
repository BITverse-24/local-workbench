import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise } from "quickjs-emscripten";
import type { WorkFacade } from "./work-facade.js";
import type { ParsedFile } from "../../tools/file-worker.js";
import { SANDBOX_PRELUDE_CODE } from "../../agent/exec/sandbox-prelude.js";
import { smartTruncate } from "../../agent/exec/smart-truncate.js";

export interface WorkSandboxOptions {
  timeoutMs?: number;
  maxMemoryBytes?: number;
  maxOutputChars?: number;
  signal?: AbortSignal;
}

export interface WorkScriptResult {
  ok: boolean;
  output: string;
  error?: { message: string; stack?: string };
  durationMs: number;
  discoveredDigests: string[];
  executedDeliverables: Array<{ filename: string; artifactId?: string }>;
}

export interface ScriptVerificationResult {
  ok: boolean;
  error?: string;
  durationMs: number;
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
  cleaned = cleaned.replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, "");
  cleaned = cleaned.replace(/^(?:const|let|var)\s+[\s\S]*?=\s*require\([^)]+\);?/gm, "");
  return cleaned.trim();
}

/**
 * Runs a sandboxed JavaScript script for Work Mode with full access to WorkFacade.
 */
export async function runWorkScript(
  rawCode: string,
  facade: WorkFacade,
  options: WorkSandboxOptions = {},
): Promise<WorkScriptResult> {
  const code = cleanScriptCode(rawCode);
  const t0 = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = t0 + timeoutMs;
  const maxMemoryBytes = options.maxMemoryBytes ?? 32 * 1024 * 1024;
  const maxOutputChars = options.maxOutputChars ?? 8000;

  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();
  const deferreds: QuickJSDeferredPromise[] = [];

  const state = {
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
      facade.text(smartTruncate(dumped, { maxChars: maxOutputChars }));
    });
    vm.setProp(vm.global, "text", textFn);
    textFn.dispose();

    // 2. Error reporting and settlement hooks
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

    // 3. Expose console.log
    const capturedLogs: string[] = [];
    const consoleObj = vm.newObject();
    const consoleLog = vm.newFunction("log", (...argHandles) => {
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
    vm.setProp(consoleObj, "log", consoleLog);
    consoleLog.dispose();
    vm.setProp(vm.global, "console", consoleObj);
    consoleObj.dispose();

    // 4. Register async Facade tools
    const registerAsyncTool = (name: string, fn: (...args: any[]) => Promise<any>) => {
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
            const val = toQuickJSValue(vm, res);
            deferred.resolve(val);
            val.dispose();
          } catch (err: any) {
            const errVal = vm.newError(String(err?.message || err));
            deferred.reject(errVal);
            errVal.dispose();
          }
        })();

        return deferred.handle;
      });

      vm.setProp(vm.global, name, toolFn);
      toolFn.dispose();
    };

    registerAsyncTool("readTable", (f, o) => facade.readTable(f, o));
    registerAsyncTool("readJson", (f) => facade.readJson(f));
    registerAsyncTool("readText", (f, o) => facade.readText(f, o));
    registerAsyncTool("readDocument", (f) => facade.readDocument(f));
    registerAsyncTool("getTableSchema", (f) => facade.getTableSchema(f));
    registerAsyncTool("emitDeliverable", (o) => facade.emitDeliverable(o));

    // 5. Inject built-in analysis and data prelude utilities
    const preludeRes = vm.evalCode(SANDBOX_PRELUDE_CODE);
    if (preludeRes.error) {
      preludeRes.error.dispose();
    } else {
      preludeRes.value.dispose();
    }

    // 6. Execute script wrapped in async IIFE
    const wrappedCode = `(async () => {
  try {
${code}
  } catch (err) {
    __reportError(err && err.message ? err.message : String(err), err && err.stack ? err.stack : undefined);
  } finally {
    __scriptSettled();
  }
})();`;

    const evalResult = vm.evalCode(wrappedCode);
    if (evalResult.error) {
      const errDump = vm.dump(evalResult.error);
      evalResult.error.dispose();
      return {
        ok: false,
        output: String(errDump?.message || errDump),
        error: { message: String(errDump?.message || errDump) },
        durationMs: Date.now() - t0,
        discoveredDigests: facade.getDiscoveredDigests(),
        executedDeliverables: facade.getExecutedDeliverables(),
      };
    }
    evalResult.value.dispose();

    // 6. Pump microtasks
    while (!state.isSettled && Date.now() < deadline && !state.isCancelled) {
      vm.runtime.executePendingJobs();
      await new Promise((r) => setImmediate(r));
    }

    if (state.isCancelled) {
      return {
        ok: false,
        output: "Script execution was cancelled.",
        error: { message: "Script execution was cancelled" },
        durationMs: Date.now() - t0,
        discoveredDigests: facade.getDiscoveredDigests(),
        executedDeliverables: facade.getExecutedDeliverables(),
      };
    }

    if (!state.isSettled) {
      return {
        ok: false,
        output: `Script timed out after ${timeoutMs}ms.`,
        error: { message: `Script timed out after ${timeoutMs}ms` },
        durationMs: Date.now() - t0,
        discoveredDigests: facade.getDiscoveredDigests(),
        executedDeliverables: facade.getExecutedDeliverables(),
      };
    }

    if (state.runtimeError) {
      return {
        ok: false,
        output: state.runtimeError.message,
        error: state.runtimeError,
        durationMs: Date.now() - t0,
        discoveredDigests: facade.getDiscoveredDigests(),
        executedDeliverables: facade.getExecutedDeliverables(),
      };
    }

    const output = facade.getTextOutput() ?? (capturedLogs.length > 0 ? capturedLogs.join("\n") : "Execution complete with 0 output.");
    return {
      ok: true,
      output,
      durationMs: Date.now() - t0,
      discoveredDigests: facade.getDiscoveredDigests(),
      executedDeliverables: facade.getExecutedDeliverables(),
    };
  } finally {
    for (const d of deferreds) {
      try {
        d.dispose();
      } catch {}
    }
    vm.dispose();
  }
}

/**
 * Runs a deterministic assertion script for deliverable verification in validateWorkArtifacts.
 */
export async function runScriptVerification(
  script: string,
  artifactData: ParsedFile & { filename?: string },
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ScriptVerificationResult> {
  const t0 = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = t0 + timeoutMs;

  const QuickJS = await getQuickJS();
  const vm = QuickJS.newContext();

  try {
    vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  } catch {}

  vm.runtime.setInterruptHandler(() => Date.now() > deadline);

  try {
    // 1. Inject parsed artifact payload
    const artifactHandle = toQuickJSValue(vm, {
      filename: artifactData.filename ?? "deliverable",
      text: artifactData.text,
      headings: artifactData.headings,
      sheets: artifactData.sheets,
      columns: artifactData.columns,
      rows: artifactData.rows,
      rowCount: artifactData.rowCount,
      json: artifactData.json,
    });
    vm.setProp(vm.global, "artifact", artifactHandle);
    artifactHandle.dispose();

    // 2. Inject assertion and prelude utilities into verification runtime
    const helperResult = vm.evalCode(SANDBOX_PRELUDE_CODE);
    if (helperResult.error) {
      helperResult.error.dispose();
    } else {
      helperResult.value.dispose();
    }

    // 3. Execute assertion script
    const evalResult = vm.evalCode(cleanScriptCode(script));
    if (evalResult.error) {
      const dumped = vm.dump(evalResult.error);
      evalResult.error.dispose();
      return {
        ok: false,
        error: String(dumped?.message || dumped),
        durationMs: Date.now() - t0,
      };
    }
    evalResult.value.dispose();

    return {
      ok: true,
      durationMs: Date.now() - t0,
    };
  } finally {
    vm.dispose();
  }
}
