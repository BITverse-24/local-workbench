import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertSafeRelativePath } from "../persistence/paths.js";
import type { ArtifactRef, AttachmentReference } from "../../shared/contracts.js";

const MAX_ATTACHMENT = 25 * 1024 * 1024;
const allowed = (mediaType: string) => mediaType === "application/pdf" || mediaType === "text/csv" || mediaType.startsWith("image/");
function dataRoot(): string {
  if (process.env.WORKBENCH_DATA_ROOT) return process.env.WORKBENCH_DATA_ROOT;
  // APP_ROOT is set by electron_app/electron/main.ts to electron_app/
  const appRoot = process.env.APP_ROOT;
  if (appRoot && existsSync(path.join(appRoot, "..", "backend", "data"))) return path.join(appRoot, "..", "backend", "data");
  if (existsSync(path.join(process.cwd(), "backend", "data"))) return path.join(process.cwd(), "backend", "data");
  if (existsSync(path.join(process.cwd(), "..", "backend", "data"))) return path.join(process.cwd(), "..", "backend", "data");
  return existsSync(path.join(process.cwd(), "backend")) ? path.join(process.cwd(), "backend", "data") : path.join(process.cwd(), "data");
}
export function absoluteDataPath(relativePath: string): string { assertSafeRelativePath(relativePath); const root = path.resolve(dataRoot()); const target = path.resolve(root, relativePath); if (!target.startsWith(`${root}${path.sep}`)) throw new Error("data path escapes root"); return target; }
export function runRoot(runId: string): string { if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("invalid run id"); return path.join(dataRoot(), "runs", runId); }
export function createRunDirectories(runId: string): string { const root = runRoot(runId); for (const name of ["input", "intermediate", "output", "logs"]) mkdirSync(path.join(root, name), { recursive: true }); return root; }
export function resolveRunPath(runId: string, relativePath: string, area?: "input" | "intermediate" | "output" | "logs"): string { assertSafeRelativePath(relativePath); const root = runRoot(runId); const target = path.resolve(root, relativePath); if (!target.startsWith(`${root}${path.sep}`)) throw new Error("path escapes run"); if (area && !target.startsWith(`${path.join(root, area)}${path.sep}`)) throw new Error("path outside permitted run area"); return target; }
export function registerAttachment(runId: string, input: { filename: string; mediaType: string; sizeBytes: number; base64OrBuffer: string | Buffer }): AttachmentReference { if (!allowed(input.mediaType)) throw new Error("unsupported attachment type"); const bytes = typeof input.base64OrBuffer === "string" ? Buffer.from(input.base64OrBuffer, "base64") : input.base64OrBuffer; if (input.sizeBytes !== bytes.length || bytes.length > MAX_ATTACHMENT) throw new Error("attachment size rejected"); const filename = path.basename(input.filename); if (!filename || filename !== input.filename || /[\0]/.test(filename)) throw new Error("invalid attachment filename"); createRunDirectories(runId); const relativePath = `runs/${runId}/input/${randomUUID()}-${filename}`; writeFileSync(absoluteDataPath(relativePath), bytes, { flag: "wx" }); return { attachmentId: randomUUID(), filename, mediaType: input.mediaType, sizeBytes: bytes.length, relativePath }; }
export function readRunFile(runId: string, relativePath: string, area: "input" | "intermediate" | "output" = "input"): Buffer { const expected = resolveRunPath(runId, relativePath.replace(`runs/${runId}/`, ""), area); return readFileSync(expected); }
export function writeRunFile(runId: string, area: "intermediate" | "output" | "logs", filename: string, content: string | Buffer): string { assertSafeRelativePath(filename); const target = resolveRunPath(runId, `${area}/${filename}`, area); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content, { flag: "wx" }); return `runs/${runId}/${area}/${filename}`; }
export function artifactRef(runId: string, kind: ArtifactRef["kind"], filename: string, relativePath: string): ArtifactRef { const abs = resolveRunPath(runId, relativePath.replace(`runs/${runId}/`, ""), "output"); const stat = statSync(abs); return { artifactId: randomUUID(), runId, kind, filename, relativePath, sizeBytes: stat.size, createdAt: new Date().toISOString() }; }

