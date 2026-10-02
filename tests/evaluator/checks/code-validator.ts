import { copyFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createSandbox, destroySandbox, macProfile, spawnContained } from "../../harness/sandbox.js";
import { containedFile } from "../../helpers/files.js";
import { terminateTree, watchWorker } from "../../harness/watchdog.js";
import { throwIfInterrupted } from "../../helpers/cancellation.js";

export async function validateParser(root: string, relative: string, runtimeRoot: string, signal?: AbortSignal): Promise<{ pass: boolean; results: unknown[] }> {
  throwIfInterrupted(signal);
  let source: string;
  try { source = containedFile(root, relative); }
  catch (error) { return { pass: false, results: [{ pass: false, error: `Candidate missing or unreadable: ${String(error)}` }] }; }
  const validator = realpathSync(path.join(runtimeRoot, "tests", "evaluator", "validators", "flow-b-parser-check.py"));
  const python = realpathSync("/opt/homebrew/bin/python3");
  const pythonRuntime = path.resolve(python, "..", "..");
  const cases = [
    { csv: 'name,value\n"pump, east",17\n', expected: [{ name: "pump, east", value: "17" }] },
    { csv: 'name,value\n"a ""quoted"" name",8\n', expected: [{ name: 'a "quoted" name', value: "8" }] },
    { csv: "name,value\r\nalpha,2\r\n\r\nbeta,3\r\n", expected: [{ name: "alpha", value: "2" }, { name: "beta", value: "3" }] },
    { csv: "name,value\n", expected: [] },
    { csv: "", expected: [] },
    { csv: "name,value\nonlyname\n", expected: [{ name: "onlyname", value: null }] },
    ...Array.from({ length: 3 }, () => { const token = randomBytes(8).toString("hex"); return { csv: `name,value\n"${token}, suffix",${token}\n`, expected: [{ name: `${token}, suffix`, value: token }] }; }),
  ];
  const results: unknown[] = [];
  for (const test of cases) {
    throwIfInterrupted(signal);
    const box = createSandbox(path.join(runtimeRoot, "tests", ".runtime", "validators"));
    const candidate = path.join(box.workspace, "candidate.py");
    copyFileSync(source, candidate);
    const child = spawnContained(box, macProfile(box, [validator, pythonRuntime, "/opt/homebrew/opt"], undefined, [box.tmp]), python, ["-I", "-B", validator, candidate]);
    let stopWatch: (() => void) | undefined;
    let onInterrupt: (() => void) | undefined;
    try {
      const actual = await new Promise<unknown>((resolve, reject) => {
        let stdout = "", stderr = "";
        stopWatch = watchWorker(child, box, 10000, (reason) => reject(new Error(`Validator ${reason}`)));
        onInterrupt = () => { terminateTree(child); reject(new Error("Validation interrupted by operator")); };
        signal?.addEventListener("abort", onInterrupt, { once: true });
        child.on("error", (e) => { reject(e); });
        child.stdout.on("data", (b: Buffer) => { stdout += b; if (stdout.length > 1048576) { terminateTree(child); reject(new Error("Validator output limit")); } });
        child.stderr.on("data", (b: Buffer) => { stderr = (stderr + b).slice(-2000); });
        child.on("exit", (code) => { try { if (code !== 0) throw new Error(`Validator exited ${code}: ${stderr}`); resolve(JSON.parse(stdout)); } catch (e) { reject(e); } });
        child.stdin.end(JSON.stringify({ csv: test.csv }));
      }) as { result?: unknown };
      const pass = JSON.stringify(actual.result) === JSON.stringify(test.expected);
      results.push({ pass, input: test.csv, expected: test.expected, actual: actual.result });
      if (!pass) return { pass: false, results };
    } catch (error) { results.push({ pass: false, error: String(error) }); return { pass: false, results }; }
    finally { stopWatch?.(); if (onInterrupt) signal?.removeEventListener("abort", onInterrupt); terminateTree(child); destroySandbox(box); }
  }
  return { pass: true, results };
}
