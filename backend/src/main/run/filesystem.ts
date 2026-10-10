import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { resolveSafe } from "../harness/path-guard.js";
import { lstatSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertSafeRelativePath } from "../persistence/paths.js";
import type { ArtifactRef, AttachmentReference } from "../../shared/contracts.js";

const MAX_ATTACHMENT = 25 * 1024 * 1024;

let configuredDataDir: string | null = null;

/** Set by `initBackend` from the Electron-provided config. Overrides env/default. */
export function setDataDir(dir: string): void {
  configuredDataDir = dir;
}

export function dataRoot(): string {
  if (configuredDataDir) return configuredDataDir;
  if (process.env.WORKBENCH_DATA_ROOT) return process.env.WORKBENCH_DATA_ROOT;
  return path.join(process.cwd(), "data");
}
export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const fd = openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, bytesRead));
  } finally { closeSync(fd); }
  return hash.digest("hex");
}
export function absoluteDataPath(relativePath: string): string { assertSafeRelativePath(relativePath); const root = path.resolve(dataRoot()); const target = path.resolve(root, relativePath); if (!target.startsWith(`${root}${path.sep}`)) throw new Error("data path escapes root"); return target; }
export function runRoot(runId: string): string { if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("invalid run id"); return path.join(dataRoot(), "runs", runId); }
function rejectStorageSymlinks(directories: string[]): void {
  for (const directory of directories) {
    // lstat also finds a dangling symlink, which existsSync does not find.
    try {
      if (lstatSync(directory).isSymbolicLink()) throw new Error("Run storage directory cannot be a symlink.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export function createRunDirectories(runId: string): string {
  const root = runRoot(runId);
  const areas = ["input", "intermediate", "output", "logs"].map(name => path.join(root, name));
  rejectStorageSymlinks([path.join(dataRoot(), "runs"), root, ...areas]);
  for (const directory of areas) mkdirSync(directory, { recursive: true });
  return root;
}
export function resolveRunPath(runId: string, relativePath: string, area?: "input" | "intermediate" | "output" | "logs"): string { assertSafeRelativePath(relativePath); const root = runRoot(runId); const target = path.resolve(root, relativePath); if (!target.startsWith(`${root}${path.sep}`)) throw new Error("path escapes run"); if (area) { const areaRoot = path.join(root, area); if (target !== areaRoot && !target.startsWith(`${areaRoot}${path.sep}`)) throw new Error("path outside permitted run area"); }
  rejectStorageSymlinks([path.join(dataRoot(), "runs"), root, ...(area ? [path.join(root, area)] : [])]);
  resolveSafe(area?path.join(root,area):root,(area?path.relative(path.join(root,area),target):relativePath)||"."); return target; }
export function registerAttachment(runId: string, input: { filename: string; mediaType: string; sizeBytes: number; base64OrBuffer: string | Buffer }): AttachmentReference { const bytes = typeof input.base64OrBuffer === "string" ? Buffer.from(input.base64OrBuffer, "base64") : input.base64OrBuffer; if (input.sizeBytes !== bytes.length || bytes.length > MAX_ATTACHMENT) throw new Error("attachment size rejected"); const filename = path.basename(input.filename); if (!filename || filename !== input.filename || /[\0]/.test(filename)) throw new Error("invalid attachment filename"); createRunDirectories(runId); const alias = `${randomUUID()}-${filename}`; const relativePath = `runs/${runId}/input/${alias}`; writeFileSync(resolveRunPath(runId, `input/${alias}`, "input"), bytes, { flag: "wx" }); try { writeFileSync(resolveRunPath(runId, `input/${filename}`, "input"), bytes, { flag: "wx" }); } catch {} return { attachmentId: randomUUID(), filename, mediaType: input.mediaType, sizeBytes: bytes.length, relativePath }; }
export function readRunFile(runId: string, relativePath: string, area: "input" | "intermediate" | "output" = "input"): Buffer { const expected = resolveRunPath(runId, relativePath.replace(`runs/${runId}/`, ""), area); return readFileSync(expected); }
export function writeRunFile(runId: string, area: "intermediate" | "output" | "logs", filename: string, content: string | Buffer, overwrite = false): string {
  assertSafeRelativePath(filename);
  createRunDirectories(runId);
  const target = resolveRunPath(runId, `${area}/${filename}`, area);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, { flag: overwrite ? "w" : "wx" });
  return `runs/${runId}/${area}/${filename}`;
}
export function artifactRef(runId: string, kind: ArtifactRef["kind"], filename: string, relativePath: string): ArtifactRef {
  const abs = resolveRunPath(runId, relativePath.replace(`runs/${runId}/`, ""), "output");
  let size = 0;
  let sha256: string | undefined;
  try {
    size = statSync(abs).size;
    sha256 = sha256File(abs);
  } catch {
    size = 0;
  }
  return { artifactId: randomUUID(), runId, kind, filename, relativePath, sizeBytes: size, sha256, createdAt: new Date().toISOString() };
}
