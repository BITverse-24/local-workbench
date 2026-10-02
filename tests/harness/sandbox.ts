import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Scenario } from "../scenarios/schema.js";
import { within, snapshot } from "../helpers/files.js";

export interface Sandbox { root: string; workspace: string; attachments: string; data: string; tmp: string; canary: string; secret: string; }
function literal(value: string): string { return JSON.stringify(value); }
export function createSandbox(parent: string): Sandbox {
  mkdirSync(parent, { recursive: true });
  const root = realpathSync(mkdtempSync(path.join(parent, "scenario-")));
  const result: Sandbox = { root, workspace: path.join(root, "workspace"), attachments: path.join(root, "attachments"), data: path.join(root, "data"), tmp: path.join(root, "tmp"), canary: path.join(root, "canary"), secret: `CANARY_${randomBytes(24).toString("hex")}` };
  for (const dir of [result.workspace, result.attachments, result.data, result.tmp, result.canary, path.join(root, "config")]) mkdirSync(dir);
  writeFileSync(path.join(result.canary, "secret.txt"), result.secret);
  return result;
}
// Minimal deterministic fixture PDF; expected source facts stay in supervisor memory.
export function fixturePDF(text: string): Buffer {
  const lines = text.split("\n");
  const content = `BT /F1 11 Tf 40 780 Td ${lines.map((line, i) => `${i ? "0 -15 Td " : ""}(${line.replace(/[\\()]/g, "\\$&")}) Tj`).join("\n")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
export function stageScenario(sandbox: Sandbox, scenario: Scenario): void {
  for (const [dir, fixtures] of [[sandbox.workspace, scenario.setup.workspace], [sandbox.attachments, scenario.setup.attachments], [path.join(sandbox.root, "kb"), scenario.setup.knowledgeBase]] as const) {
    mkdirSync(dir, { recursive: true });
    for (const file of fixtures) {
      const target = path.resolve(dir, file.path);
      if (!within(dir, target)) throw new Error("Fixture escapes staging root");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.kind === "pdf" ? fixturePDF(file.content) : file.content);
    }
  }
}
export function macProfile(sandbox: Sandbox, reads: string[], relayPort?: number, writable = [sandbox.workspace, sandbox.data, sandbox.tmp, sandbox.canary]): string {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) throw new Error("Native macOS sandbox unavailable; uncontained execution is forbidden");
  // dyld requires reading the root directory itself. This is a literal rule,
  // not a recursive grant; user-directory contents remain denied.
  const rules = ["(version 1)", "(deny default)", "(allow process-exec)", "(allow process-fork)", "(allow sysctl-read)", "(allow file-read-metadata)", "(allow file-read-data (literal \"/\"))", "(allow mach-lookup (global-name \"com.apple.system.logger\"))", "(allow file-read* (subpath \"/System\") (subpath \"/usr\") (subpath \"/bin\") (subpath \"/sbin\") (literal \"/dev/null\") (literal \"/dev/urandom\") (literal \"/dev/random\"))", "(allow file-write* (literal \"/dev/null\"))"];
  // Synthetic canaries are deliberately OS-accessible bait outside the workspace.
  // Otherwise the supervisor would mask a missing application-level path guard.
  for (const file of [sandbox.workspace, sandbox.attachments, sandbox.data, sandbox.tmp, sandbox.canary, path.join(sandbox.root, "config"), path.join(sandbox.root, "kb"), ...reads].filter(existsSync)) rules.push(`(allow file-read* (subpath ${literal(realpathSync(file))}))`);
  for (const file of writable) rules.push(`(allow file-write* (subpath ${literal(realpathSync(file))}))`);
  // SBPL accepts localhost (not a numeric host) for port-scoped loopback rules.
  if (relayPort) rules.push(`(allow network-outbound (remote ip "localhost:${relayPort}"))`);
  return rules.join("\n");
}
export function sanitizedEnvironment(sandbox: Sandbox): NodeJS.ProcessEnv {
  // Never spread process.env: attacker, judge and other host credentials stay outside.
  return { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: sandbox.tmp, LANG: "en_US.UTF-8", ELECTRON_RUN_AS_NODE: "1", WORKBENCH_AGENT_V2: "true", WORKBENCH_DATA_ROOT: sandbox.data, WORKBENCH_DB_PATH: path.join(sandbox.data, "workbench.db") };
}
export function spawnContained(sandbox: Sandbox, profile: string, executable: string, args: string[]) {
  return spawn("/usr/bin/sandbox-exec", ["-p", profile, executable, ...args], { cwd: sandbox.workspace, env: sanitizedEnvironment(sandbox), stdio: ["pipe", "pipe", "pipe"], detached: true });
}
export function destroySandbox(sandbox: Sandbox): void { rmSync(sandbox.root, { recursive: true, force: true }); }
export function diskUsage(sandbox: Sandbox): number {
  let bytes = 0, entries = 0;
  const visit = (directory: string, depth: number) => {
    if (depth > 128) throw new Error("Scenario directory-depth limit exceeded");
    for (const name of readdirSync(directory)) {
      if (++entries > 100000) throw new Error("Scenario file-count limit exceeded");
      const file = path.join(directory, name);
      let item; try { item = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (item.isDirectory()) visit(file, depth + 1); else bytes += item.size;
      if (bytes > 1024 ** 3) return;
    }
  };
  visit(sandbox.root, 0); return bytes;
}

export function runtimeReadPaths(): string[] {
  const result = new Set<string>();
  const inspect = (binary: string) => {
    const resolved = realpathSync(binary);
    if (resolved.startsWith("/opt/homebrew/Cellar/")) result.add(resolved.split("/").slice(0, 6).join("/"));
    else if (!resolved.startsWith("/usr/") && !resolved.startsWith("/bin/")) result.add(path.dirname(resolved));
    try {
      const linked = execFileSync("/usr/bin/otool", ["-L", resolved], { encoding: "utf8", timeout: 3000 }).split("\n").slice(1);
      for (const line of linked) {
        const file = line.trim().split(" ")[0];
        if (file.startsWith("/opt/homebrew/") && existsSync(file)) result.add(path.dirname(realpathSync(file)));
      }
    } catch { /* scripts such as npm have no Mach-O dependency table */ }
  };
  for (const name of ["python3", "rg", "node", "npm"]) {
    const binary = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map((dir) => path.join(dir, name)).find(existsSync);
    if (binary) inspect(binary);
  }
  return [...result];
}
