import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PermissionError, resolveSafe } from '../path-guard.js';

/** Internal backup paths bypass model access, never filesystem containment. */
export function backupDestination(workspaceRoot: string, relativePath: string): { destination: string; relativePath: string } {
  const root = resolveSafe(workspaceRoot, '.');
  const backupRoot = path.join(root, '.harness_backups');
  try {
    const stat = lstatSync(backupRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PermissionError('Backup storage must be a workspace directory, not a symlink.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(backupRoot, { mode: 0o700 });
  }
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const uniqueRoot = path.join(backupRoot, id);
  mkdirSync(uniqueRoot, { mode: 0o700 });
  const relative = path.join('.harness_backups', id, relativePath);
  const destination = path.join(root, relative);
  if (!destination.startsWith(uniqueRoot + path.sep)) throw new PermissionError('Backup path escapes its directory.');
  if (existsSync(destination)) throw new PermissionError('Backup destination already exists.');
  mkdirSync(path.dirname(destination), { recursive: true });
  return { destination, relativePath: relative };
}
