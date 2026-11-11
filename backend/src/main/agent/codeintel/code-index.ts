import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { dataRoot } from "../../run/filesystem.js";
import { parseFileSync, type ImportBinding, type ParsedFile, type SymbolRange, type SymbolReference } from "../symbol-index.js";

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|java|c|cc|cpp|cxx|h|hpp|cs)$/i;
const IGNORED_DIRS = new Set(["node_modules", ".git", "__pycache__", ".harness_backups", ".venv", "venv", "dist", "build", "target", "bin", "obj"]);

export interface DefinitionMatch {
  path: string;
  name: string;
  kind: SymbolRange["kind"];
  line: number;
  endLine: number;
  exported: boolean;
  signature: string;
}

export interface ReferenceMatch {
  path: string;
  line: number;
  col: number;
  kind: SymbolReference["kind"];
  text: string;
}

export interface CodeSearchMatch {
  path: string;
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

interface IndexedEntry {
  digest: string;
  parsed: ParsedFile;
  lines: string[];
  persisted?: boolean;
}

export function splitIdentifierTokens(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-./:\\]+/g, " ")
    .toLowerCase();
}

function collectSourceFiles(root: string, rel = "", out: string[] = [], limit = 2000): string[] {
  if (out.length >= limit) return out;
  let entries: string[];
  try {
    entries = readdirSync(path.join(root, rel));
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    if (out.length >= limit) break;
    if (IGNORED_DIRS.has(name) || name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    const full = path.join(root, childRel);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) collectSourceFiles(root, childRel, out, limit);
    else if (st.isFile() && st.size <= 512 * 1024 && CODE_EXT.test(name)) out.push(childRel);
  }
  return out;
}

function resolveImportPath(importerPath: string, spec: string, knownFiles: Set<string>): string | undefined {
  const dir = path.posix.dirname(importerPath);
  const cleanSpec = spec.replace(/;\s*$/, "").trim();
  const isRelative = cleanSpec.startsWith(".");
  const raw = isRelative
    ? path.posix.normalize(path.posix.join(dir, cleanSpec.replace(/\.(?:[cm]?js|jsx)$/i, "")))
    : cleanSpec.includes("/")
    ? cleanSpec
    : cleanSpec.replace(/\./g, "/");
  const candidates = [
    raw,
    ...(isRelative ? [path.posix.normalize(path.posix.join(dir, cleanSpec))] : []),
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.jsx`,
    `${raw}.mjs`,
    `${raw}.cjs`,
    `${raw}.py`,
    `${raw}.java`,
    `${raw}.h`,
    `${raw}.hpp`,
    `${raw}.c`,
    `${raw}.cc`,
    `${raw}.cpp`,
    `${raw}.cs`,
    `${raw}/index.ts`,
    `${raw}/index.js`,
    `${raw}/__init__.py`,
  ];
  const exact = candidates.find((c) => knownFiles.has(c));
  if (exact) return exact;
  const tail = raw.split("/").pop();
  if (tail) {
    for (const f of knownFiles) {
      if (
        f.endsWith(`/${raw}.java`) ||
        f.endsWith(`/${raw}.cs`) ||
        f.endsWith(`/${raw}.h`) ||
        f.endsWith(`/${raw}.hpp`) ||
        f.endsWith(`/${tail}.h`) ||
        f.endsWith(`/${tail}.hpp`) ||
        f.endsWith(`/${tail}.cs`)
      ) {
        return f;
      }
    }
  }
  return undefined;
}

export class WorkspaceCodeIndex {
  private mem = new Map<string, IndexedEntry>();
  private db?: Database.Database;
  private complete = false;

  constructor(readonly workspaceRoot: string) {}

  private openDb(): Database.Database | undefined {
    if (this.db) return this.db;
    try {
      const dir = path.join(dataRoot(), "index");
      mkdirSync(dir, { recursive: true });
      const hash = createHash("sha256").update(this.workspaceRoot).digest("hex").slice(0, 16);
      const db = new Database(path.join(dir, `${hash}.sqlite`));
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, digest TEXT NOT NULL, parsed_json TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(path, symbol, kind, start_line UNINDEXED, end_line UNINDEXED, body, tokens);
      `);
      this.db = db;
      return db;
    } catch {
      return undefined;
    }
  }

  /** Incrementally index files under a wall-clock budget (default 3000 ms). */
  build(budgetMs = 3000): { indexedFiles: number; totalFiles: number; indexComplete: boolean } {
    const deadline = Date.now() + budgetMs;
    const files = collectSourceFiles(this.workspaceRoot);
    const seen = new Set(files);
    const db = this.openDb();
    for (const old of this.mem.keys()) {
      if (!seen.has(old)) {
        this.mem.delete(old);
        if (db) {
          try {
            db.prepare("DELETE FROM files WHERE path=?").run(old);
            db.prepare("DELETE FROM code_fts WHERE path=?").run(old);
          } catch {}
        }
      }
    }
    let indexed = 0;
    for (const rel of files) {
      if (Date.now() > deadline) {
        this.complete = false;
        return { indexedFiles: indexed, totalFiles: files.length, indexComplete: false };
      }
      const full = path.join(this.workspaceRoot, rel);
      let bytes: Buffer;
      try {
        bytes = readFileSync(full);
      } catch {
        continue;
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      const cached = this.mem.get(rel);
      if (cached && cached.digest === digest && cached.persisted) {
        indexed++;
        continue;
      }
      const lines = cached && cached.digest === digest ? cached.lines : bytes.toString("utf8").split(/\r?\n/);
      let parsed: ParsedFile | undefined = cached && cached.digest === digest ? cached.parsed : undefined;
      let loadedFromDb = false;
      if (!parsed && db) {
        const row = db.prepare("SELECT parsed_json FROM files WHERE path=? AND digest=?").get(rel, digest) as { parsed_json: string } | undefined;
        if (row) {
          try {
            parsed = JSON.parse(row.parsed_json) as ParsedFile;
            loadedFromDb = true;
          } catch {
            parsed = undefined;
          }
        }
      }
      if (!parsed) {
        parsed = parseFileSync(rel, bytes);
      }
      if (db && !loadedFromDb) {
        db.prepare("INSERT OR REPLACE INTO files(path, digest, parsed_json) VALUES (?, ?, ?)").run(rel, digest, JSON.stringify(parsed));
        db.prepare("DELETE FROM code_fts WHERE path=?").run(rel);
        const insert = db.prepare("INSERT INTO code_fts(path, symbol, kind, start_line, end_line, body, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)");
        if (parsed.symbols.length) {
          for (const s of parsed.symbols) {
            const body = lines.slice(Math.max(0, s.startLine - 1), Math.min(lines.length, s.endLine)).join("\n").slice(0, 2000);
            insert.run(rel, s.name, s.kind, s.startLine, s.endLine, body, splitIdentifierTokens(`${rel} ${s.name} ${body}`));
          }
        } else {
          const body = lines.slice(0, 80).join("\n").slice(0, 2000);
          insert.run(rel, path.posix.basename(rel), "module", 1, lines.length, body, splitIdentifierTokens(`${rel} ${body}`));
        }
      }
      this.mem.set(rel, { digest, parsed, lines, persisted: Boolean(db) });
      indexed++;
    }
    this.complete = true;
    return { indexedFiles: indexed, totalFiles: files.length, indexComplete: true };
  }

  isComplete(): boolean {
    return this.complete;
  }

  fileCount(): number {
    return this.mem.size;
  }

  invalidateFile(relPath: string): void {
    const clean = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    this.mem.delete(clean);
    this.complete = false;
  }

  symbols(relPath: string): SymbolRange[] {
    const clean = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const full = path.join(this.workspaceRoot, clean);
    if (!existsSync(full)) return [];
    const bytes = readFileSync(full);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const hit = this.mem.get(clean);
    if (hit && hit.digest === digest) return hit.parsed.symbols;
    const parsed = parseFileSync(clean, bytes);
    this.mem.set(clean, { digest, parsed, lines: bytes.toString("utf8").split(/\r?\n/) });
    return parsed.symbols;
  }

  definition(
    name: string,
    scopeOrOpts?: string | { path?: string; fromPath?: string; kind?: string },
  ): { matches: DefinitionMatch[]; indexComplete: boolean } {
    this.build();
    const scopePath = typeof scopeOrOpts === "string" ? scopeOrOpts : scopeOrOpts?.path;
    const fromPath = typeof scopeOrOpts === "object" ? scopeOrOpts?.fromPath?.replace(/\\/g, "/").replace(/^\.\//, "") : undefined;
    const kindFilter = typeof scopeOrOpts === "object" ? scopeOrOpts?.kind : undefined;
    const knownFiles = new Set(this.mem.keys());
    const importedTargets = new Set<string>();
    if (fromPath) {
      const importer = this.mem.get(fromPath);
      if (importer) {
        for (const imp of importer.parsed.imports) {
          const resolved = resolveImportPath(fromPath, imp.from, knownFiles);
          if (resolved) importedTargets.add(resolved);
        }
      }
    }
    const out: DefinitionMatch[] = [];
    for (const [file, entry] of this.mem) {
      if (scopePath && file !== scopePath && !file.startsWith(`${scopePath}/`)) continue;
      for (const s of entry.parsed.symbols) {
        if (kindFilter && s.kind !== kindFilter) continue;
        if (s.name === name || s.name.endsWith(`.${name}`)) {
          const sig = (entry.lines[s.startLine - 1] ?? "").trim().slice(0, 160);
          out.push({ path: file, name: s.name, kind: s.kind, line: s.startLine, endLine: s.endLine, exported: s.exported, signature: sig });
        }
      }
    }
    out.sort((a, b) => {
      const impA = Number(importedTargets.has(a.path) || a.path === fromPath);
      const impB = Number(importedTargets.has(b.path) || b.path === fromPath);
      return impB - impA || Number(b.exported) - Number(a.exported) || a.path.localeCompare(b.path) || a.line - b.line;
    });
    return { matches: out, indexComplete: this.complete };
  }

  /**
   * Import-aware reference finder: reports occurrences in the defining file(s), in files that
   * import the symbol or its module, or across the workspace when no import graph edge restricts it.
   */
  references(name: string, options?: { path?: string; maxResults?: number }): { matches: ReferenceMatch[]; precision: "import-filtered" | "workspace-wide"; indexComplete: boolean } {
    this.build();
    const maxResults = options?.maxResults ?? 40;
    const shortName = name.includes(".") ? name.split(".").pop()! : name;
    const knownFiles = new Set(this.mem.keys());
    const defFiles = new Set<string>();
    for (const [file, entry] of this.mem) {
      if (entry.parsed.symbols.some((s) => s.name === name || s.name === shortName || s.name.endsWith(`.${shortName}`))) defFiles.add(file);
    }
    const candidateFiles = new Set<string>(defFiles);
    for (const [file, entry] of this.mem) {
      for (const imp of entry.parsed.imports) {
        const target = resolveImportPath(file, imp.from, knownFiles);
        if (imp.names.includes(shortName) || (target && defFiles.has(target))) candidateFiles.add(file);
      }
    }
    const filterByImports = candidateFiles.size > 0;
    const matches: ReferenceMatch[] = [];
    const seen = new Set<string>();
    for (const [file, entry] of this.mem) {
      if (options?.path && file !== options.path && !file.startsWith(`${options.path}/`)) continue;
      if (filterByImports && !candidateFiles.has(file)) continue;
      for (const ref of entry.parsed.refs) {
        if (ref.name !== shortName && ref.name !== name) continue;
        const key = `${file}:${ref.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({ path: file, line: ref.line, col: ref.col, kind: ref.kind, text: (entry.lines[ref.line - 1] ?? "").trim().slice(0, 180) });
        if (matches.length >= maxResults) break;
      }
      if (matches.length >= maxResults) break;
    }
    return { matches, precision: filterByImports ? "import-filtered" : "workspace-wide", indexComplete: this.complete };
  }

  /**
   * Compact repository map ranked by import-graph in-degree + personalization on focus files.
   * Capped strictly to `budgetTokens` (~4 chars per token).
   */
  repoMap(options?: { budgetTokens?: number; focusFiles?: string[] }): { map: string; totalFiles: number; indexComplete: boolean } {
    this.build();
    const maxChars = Math.max(200, Math.min(4000, (options?.budgetTokens ?? 800) * 4));
    const known = new Set(this.mem.keys());
    const inDegree = new Map<string, number>();
    for (const f of known) inDegree.set(f, 0);
    for (const [file, entry] of this.mem) {
      for (const imp of entry.parsed.imports) {
        const target = resolveImportPath(file, imp.from, known);
        if (target) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      }
    }
    const focus = new Set((options?.focusFiles ?? []).map((f) => f.replace(/\\/g, "/")));
    const ranked = [...this.mem.entries()].sort(([pathA], [pathB]) => {
      const scoreA = (inDegree.get(pathA) ?? 0) + (focus.has(pathA) ? 10 : 0);
      const scoreB = (inDegree.get(pathB) ?? 0) + (focus.has(pathB) ? 10 : 0);
      return scoreB - scoreA || pathA.localeCompare(pathB);
    });
    const lines: string[] = [];
    let chars = 0;
    for (const [file, entry] of ranked) {
      const top = entry.parsed.symbols.filter((s) => s.exported || !s.name.includes(".")).slice(0, 8).map((s) => `${s.name}:${s.startLine}`);
      const line = top.length ? `${file}: ${top.join(", ")}` : file;
      if (chars + line.length + 1 > maxChars) break;
      lines.push(line);
      chars += line.length + 1;
    }
    return { map: lines.join("\n"), totalFiles: this.mem.size, indexComplete: this.complete };
  }

  /** Lexical symbol-chunk search using SQLite FTS5 over identifier-split tokens (zero inference calls). */
  searchCode(
    query: string,
    optsOrMax: number | { path?: string; maxResults?: number } = 15,
  ): { results: CodeSearchMatch[]; indexComplete: boolean } {
    this.build();
    const maxResults = typeof optsOrMax === "number" ? optsOrMax : optsOrMax.maxResults ?? 15;
    const scopePath = typeof optsOrMax === "object" ? optsOrMax.path?.replace(/\\/g, "/").replace(/^\.\//, "") : undefined;
    const terms = splitIdentifierTokens(query)
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 8);
    if (!terms.length) return { results: [], indexComplete: this.complete };
    const db = this.openDb();
    if (db) {
      try {
        const ftsQuery = terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
        const rows = db
          .prepare("SELECT path, symbol, kind, start_line, end_line, body, bm25(code_fts) AS rank FROM code_fts WHERE code_fts MATCH ? ORDER BY rank LIMIT ?")
          .all(ftsQuery, maxResults * 3) as Array<{ path: string; symbol: string; kind: string; start_line: number; end_line: number; body: string; rank: number }>;
        const filtered = scopePath ? rows.filter((r) => r.path === scopePath || r.path.startsWith(`${scopePath}/`)) : rows;
        if (filtered.length > 0) {
          const mapped = filtered.map((r) => {
            const symTokens = splitIdentifierTokens(r.symbol);
            const symHits = terms.filter((t) => symTokens.includes(t)).length;
            const pathTokens = splitIdentifierTokens(r.path);
            const pathHits = terms.filter((t) => pathTokens.includes(t)).length;
            const score = Number((-r.rank + symHits * 10 + pathHits * 3).toFixed(3));
            return {
              path: r.path,
              symbol: r.symbol,
              kind: r.kind,
              startLine: Number(r.start_line),
              endLine: Number(r.end_line),
              snippet: r.body.split("\n").slice(0, 6).join("\n").slice(0, 320),
              score,
            };
          });
          mapped.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
          return {
            results: mapped.slice(0, maxResults),
            indexComplete: this.complete,
          };
        }
      } catch {
        /* fall back to in-memory scoring */
      }
    }
    const scored: CodeSearchMatch[] = [];
    for (const [file, entry] of this.mem) {
      if (scopePath && file !== scopePath && !file.startsWith(`${scopePath}/`)) continue;
      for (const s of entry.parsed.symbols) {
        const hay = splitIdentifierTokens(`${file} ${s.name}`);
        const hits = terms.filter((t) => hay.includes(t)).length;
        if (hits > 0) {
          scored.push({
            path: file,
            symbol: s.name,
            kind: s.kind,
            startLine: s.startLine,
            endLine: s.endLine,
            snippet: (entry.lines[s.startLine - 1] ?? "").trim().slice(0, 200),
            score: hits,
          });
        }
      }
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return { results: scored.slice(0, maxResults), indexComplete: this.complete };
  }
}

const cache = new Map<string, WorkspaceCodeIndex>();
export function getWorkspaceCodeIndex(workspaceRoot: string): WorkspaceCodeIndex {
  const key = path.resolve(workspaceRoot);
  let idx = cache.get(key);
  if (!idx) {
    idx = new WorkspaceCodeIndex(key);
    cache.set(key, idx);
  }
  return idx;
}

export function invalidateWorkspaceCodeIndex(workspaceRoot?: string): void {
  if (!workspaceRoot) cache.clear();
  else cache.delete(path.resolve(workspaceRoot));
}

export type { ImportBinding };
