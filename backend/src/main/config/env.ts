// Minimal .env loader — no new dependencies, bundler-friendly.
// Canonical file: backend/.env (gitignored; see backend/.env.example).
// Never overwrites an already-set variable; never logs values.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // backend/src/main/config (source) or dist-electron (bundled)

export function findBackendEnvFile(): string | null {
  const fromEnv = process.env.WORKBENCH_ENV_PATH;
  const candidates: string[] = [];
  if (fromEnv) candidates.push(path.resolve(fromEnv));
  // Source layout: backend/src/main/config -> backend/.env
  candidates.push(path.resolve(here, "../../../.env"));
  // Bundled layout: electron_app/dist-electron/main.js -> <repo>/backend/.env
  candidates.push(path.resolve(here, "../../backend/.env"));
  // APP_ROOT is set by electron_app/electron/main.ts to electron_app/
  const appRoot = process.env.APP_ROOT;
  if (appRoot) candidates.push(path.resolve(appRoot, "../backend/.env"));
  // cwd variants (`npm run dev` may run from repo root, backend/, or electron_app/)
  candidates.push(path.resolve(process.cwd(), "backend/.env"));
  candidates.push(path.resolve(process.cwd(), "../backend/.env"));
  candidates.push(path.resolve(process.cwd(), ".env"));
  for (const candidate of new Set(candidates)) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore and try next
    }
  }
  return null;
}

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(body);
  if (!match) return null;
  let value = match[2].trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

/** Load backend/.env into process.env (missing keys only). Returns the file used, or null. */
export function loadBackendEnv(filePath?: string): string | null {
  const resolved = filePath ?? findBackendEnvFile();
  if (!resolved) return null;
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
  return resolved;
}
