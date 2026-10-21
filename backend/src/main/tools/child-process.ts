import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { currentRuntimeScope, assertRuntimeActive, abortError } from "../run/runtime-scope.js";

/** Kill the process group, including children of shells, on timeout or cancellation. */
export function executeProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; signal?: AbortSignal;
  windowsVerbatimArguments?: boolean;
}): Promise<{ stdout: string; stderr: string }> {
  assertRuntimeActive();
  const signal = options.signal ?? currentRuntimeScope()?.signal;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", windowsHide: true, windowsVerbatimArguments: options.windowsVerbatimArguments, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutDecoder=new StringDecoder("utf8"),stderrDecoder=new StringDecoder("utf8");
    let stdout = "", stderr = "", size = 0, timedOut = false, overflow = false, aborted = false;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => { child.kill(); });
      }
      else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const onAbort = () => { aborted = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, options.timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    child.stdout.on("data", (bytes: Buffer) => { size += bytes.length; stdout += stdoutDecoder.write(bytes); if (size > options.maxBuffer) { overflow = true; kill(); } });
    child.stderr.on("data", (bytes: Buffer) => { size += bytes.length; stderr += stderrDecoder.write(bytes); if (size > options.maxBuffer) { overflow = true; kill(); } });
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", (code, exitSignal) => {
      stdout+=stdoutDecoder.end();stderr+=stderrDecoder.end();cleanup();
      if (aborted) return reject(abortError());
      if (code === 0 && !timedOut && !overflow) return resolve({ stdout, stderr });
      reject(Object.assign(new Error(stderr || (timedOut ? "Process timed out" : overflow ? "Process output limit exceeded" : exitSignal ? `Process terminated by ${exitSignal}` : `Process exited with code ${code}`)), {
        code: overflow ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : code ?? 1, stdout, stderr, killed: timedOut, signal: exitSignal,
      }));
    });
    if (signal?.aborted) onAbort();
  });
}
