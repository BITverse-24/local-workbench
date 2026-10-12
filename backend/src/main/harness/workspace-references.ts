import { readdir, lstat } from "node:fs/promises";
import { readFileSync, statSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveSafe } from "./path-guard.js";
import { IGNORE_LIST, type DirEntry } from "./tools/list-dir.js";
import type { WorkspaceReference } from "../../shared/workspace-mentions.js";
import type { AttachmentReference, ExecutionMode } from "../../shared/contracts.js";
import { writeRunFile, sha256File, absoluteDataPath } from "../run/filesystem.js";

export async function walkWorkspace(root: string, relative = ".", limit = 10000, maxDepth = 32,
  signal?: AbortSignal): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  const target = resolveSafe(root, relative);
  if (!statSync(target).isDirectory()) throw new Error(`Not a folder: ${relative}`);
  const queue = [{ dir: target, depth: 1 }];
  const entries: DirEntry[] = [];
  let truncated = false;
  while (queue.length) {
    signal?.throwIfAborted();
    const current = queue.shift()!;
    let items;
    try { items = await readdir(resolveSafe(root, path.relative(root, current.dir) || "."), { withFileTypes: true }); }
    catch (error) { if (current.dir === target) throw error; truncated = true; continue; }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      signal?.throwIfAborted();
      if (IGNORE_LIST.has(item.name) || item.name === ".backups" || item.isSymbolicLink()) continue;
      if (entries.length >= limit) return { entries, truncated: true };
      const name = path.relative(root, path.join(current.dir, item.name)).split(path.sep).join("/");
      let safe, stat;
      try { safe = resolveSafe(root, name); stat = await lstat(safe); }
      catch { truncated = true; continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        entries.push({ name, type: "directory", size: 0 });
        if (current.depth < maxDepth) queue.push({ dir: safe, depth: current.depth + 1 });
        else truncated = true;
      } else if (stat.isFile()) entries.push({ name, type: "file", size: stat.size });
    }
  }
  return { entries, truncated };
}

export async function suggestWorkspacePaths(root: string, query: string, signal?: AbortSignal) {
  const result = await walkWorkspace(root, ".", 10000, 32, signal);
  const needle = query.toLocaleLowerCase().replace(/\/$/, "");
  const score = (name: string) => {
    const value = name.toLocaleLowerCase();
    const base = value.split("/").pop()!;
    return value === needle || base === needle ? 0 : base.startsWith(needle) ? 1 : value.startsWith(needle) ? 2 : 3;
  };
  return { entries: result.entries.filter(entry => entry.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => score(a.name) - score(b.name) || a.name.localeCompare(b.name)).slice(0, 8), truncated: result.truncated };
}

export interface WorkspaceSourceManifest {
  workspaceRoot: string;
  registeredAt: string;
  references: WorkspaceReference[];
  files: Array<AttachmentReference & { sha256: string; sourcePath: string }>;
  folderEvidence: string;
}

const supported = /\.(pdf|docx|xlsx|csv|txt|md|json|svg|png|jpe?g|webp|bmp|tiff?|py|[cm]?jsx?|tsx?|ya?ml|toml|xml|html|css|sql|rs|go|c|cpp|h|sh|ini|log|env)$/i;

export async function snapshotWorkspaceReferences(input: { root: string; registeredAt: string; runId: string;
  references: WorkspaceReference[]; uploadCount: number; mode: ExecutionMode; signal?: AbortSignal;
  assertWorkspace: () => void }): Promise<WorkspaceSourceManifest> {
  const manifest: WorkspaceSourceManifest = { workspaceRoot: input.root, registeredAt: input.registeredAt,
    references: input.references, files: [], folderEvidence: "" };
  if (input.uploadCount + input.references.filter(ref => ref.kind === "file").length > 10)
    throw new Error("Select at most 10 files, including uploads and workspace mentions.");
  for (const ref of input.references) {
    input.signal?.throwIfAborted(); input.assertWorkspace();
    const source = resolveSafe(input.root, ref.path);
    if (ref.kind === "directory") {
      const listing = await walkWorkspace(input.root, ref.path, 500, 4, input.signal);
      input.assertWorkspace();
      manifest.folderEvidence += `\n--- FOLDER LIST: ${ref.path}/ (paths only; contents not read) ---\n` +
        listing.entries.map(entry => `${entry.name}${entry.type === "directory" ? "/" : ""}`).join("\n") +
        (listing.truncated ? "\n[Listing limited to 500 entries and four levels.]" : "") + "\n--- END FOLDER LIST ---\n";
      continue;
    }
    const stat = statSync(source);
    if (!stat.isFile()) throw new Error(`Not a file: ${ref.path}. Use a trailing slash for folders.`);
    if (stat.size > 10 * 1024 * 1024) throw new Error(`File exceeds 10 MB: ${ref.path}`);
    if (!supported.test(ref.path) && path.extname(ref.path)) throw new Error(`Unsupported source format: ${ref.path}`);
    const attachmentId = randomUUID();
    const filename = path.basename(ref.path);
    const extname = path.extname(filename);
    const storageName = `${attachmentId}-${path.basename(filename, extname).slice(0, 170)}${extname}`;
    // Recheck containment immediately before the read, including symlink targets.
    const bytes = readFileSync(resolveSafe(input.root, ref.path));
    if (bytes.length > 10 * 1024 * 1024) throw new Error(`File exceeds 10 MB: ${ref.path}`);
    if (!/\.(pdf|docx|xlsx|png|jpe?g|webp|bmp|tiff?)$/i.test(ref.path)) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error(`Unsupported binary source: ${ref.path}`);
    }
    input.assertWorkspace();
    const relativePath = writeRunFile(input.runId, "input", storageName, bytes);
    if (input.mode === "work") chmodSync(absoluteDataPath(relativePath), 0o444);
    const ext = path.extname(ref.path).slice(1).toLowerCase();
    const mediaType = /^(png|jpe?g|webp|bmp|tiff?|svg)$/.test(ext)
      ? `image/${ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext}` : "application/octet-stream";
    manifest.files.push({ attachmentId, filename, relativePath, mediaType, sizeBytes: bytes.length,
      sha256: sha256File(absoluteDataPath(relativePath)), sourcePath: ref.path });
  }
  return manifest;
}
