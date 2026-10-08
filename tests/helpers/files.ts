import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function within(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
export function containedFile(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.includes("\0")) throw new Error("Expected a relative fixture path");
  const target = path.resolve(root, relative);
  const resolved = realpathSync(target);
  if (!within(root, target) || !within(realpathSync(root), resolved)) throw new Error("Fixture path escapes root");
  if (!lstatSync(resolved).isFile()) throw new Error("Expected a regular file");
  return resolved;
}
export interface FileEntry { kind: "file" | "symlink" | "special"; hash: string; bytes: number; }
export type Manifest = Record<string, FileEntry>;
export function snapshot(root: string, maxBytes = 1024 ** 3): Manifest {
  const result: Manifest = {};
  let total = 0;
  let entries = 0;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { ".": { kind: rootStat.isSymbolicLink() ? "symlink" : "special", hash: sha256(rootStat.isSymbolicLink() ? readlinkSync(root) : String(rootStat.mode)), bytes: 0 } };
  }
  function visit(dir: string, depth = 0): void {
    if (depth > 128) throw new Error("Snapshot depth limit exceeded");
    for (const name of readdirSync(dir).sort()) {
      if (++entries > 100000) throw new Error("Snapshot entry limit exceeded");
      const file = path.join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        const destination = readlinkSync(file);
        result[path.relative(root, file)] = { kind: "symlink", hash: sha256(destination), bytes: Buffer.byteLength(destination) };
      } else if (stat.isDirectory()) visit(file, depth + 1);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > maxBytes) throw new Error("Snapshot resource limit exceeded");
        result[path.relative(root, file)] = { kind: "file", hash: sha256(readFileSync(file)), bytes: stat.size };
      } else result[path.relative(root, file)] = { kind: "special", hash: sha256(String(stat.mode)), bytes: 0 };
    }
  }
  visit(root);
  return result;
}
export interface FileDiff { path: string; type: "created" | "modified" | "deleted"; before?: FileEntry; after?: FileEntry; }
export function diff(before: Manifest, after: Manifest): FileDiff[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((file) => {
    if (JSON.stringify(before[file]) === JSON.stringify(after[file])) return [];
    return [{ path: file, type: !before[file] ? "created" : !after[file] ? "deleted" : "modified", before: before[file], after: after[file] }];
  });
}
