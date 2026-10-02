import type { ChildProcess } from "node:child_process";
import { execFileSync, execFile } from "node:child_process";
import { diskUsage, type Sandbox } from "./sandbox.js";

const observed = new WeakMap<ChildProcess, Set<number>>();
function processRows(): number[][] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss="], { encoding: "utf8", timeout: 3000 }).trim().split("\n").map((row) => row.trim().split(/\s+/).map(Number));
}
function descendants(child: ChildProcess, rows: number[][]): Set<number> {
  const pids = observed.get(child) ?? new Set<number>();
  if (child.pid) pids.add(child.pid);
  let changed = true;
  while (changed) { changed = false; for (const [pid, parent, group] of rows) if ((pids.has(parent) || group === child.pid) && !pids.has(pid)) { pids.add(pid); changed = true; } }
  observed.set(child, pids);
  return pids;
}

export function terminateTree(child: ChildProcess): void {
  if (!child.pid) return;
  // Include descendants that changed process group (spawn({detached:true})).
  let pids = observed.get(child) ?? new Set<number>();
  try { pids = descendants(child, processRows()); } catch {}
  for (const pid of [...pids].reverse()) if (pid !== child.pid) try { process.kill(pid, "SIGKILL"); } catch {}
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  try { child.kill("SIGKILL"); } catch {}
}
export function watchWorker(child: ChildProcess, sandbox: Sandbox, deadlineMs: number, onLimit: (reason: string) => void): () => void {
  let stopped = false;
  let sampling = false, failures = 0;
  const fail = (reason: string) => { if (stopped) return; stopped = true; clearInterval(timer); clearTimeout(deadline); onLimit(reason); terminateTree(child); };
  const deadline = setTimeout(() => fail("scenario_deadline_exceeded"), deadlineMs);
  const timer = setInterval(async () => {
    if (sampling || stopped) return;
    sampling = true;
    try {
      const output = await new Promise<string>((resolve, reject) => execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss="], { encoding: "utf8", timeout: 3000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      if (stopped) return;
      const rows = output.trim().split("\n").map((row) => row.trim().split(/\s+/).map(Number));
      failures = 0;
      const pids = descendants(child, rows);
      const rssKB = rows.reduce((sum, [pid, , , rss]) => sum + (pids.has(pid) ? rss : 0), 0);
      if (rssKB * 1024 > 4 * 1024 ** 3) fail("worker_memory_limit_exceeded");
      else if (diskUsage(sandbox) > 1024 ** 3) fail("worker_disk_limit_exceeded");
    } catch (error) { if (++failures >= 3) fail(`watchdog_unavailable: ${String(error)}`); }
    finally { sampling = false; }
  }, 1000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); clearTimeout(deadline); };
}
