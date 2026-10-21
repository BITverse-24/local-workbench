import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export const sandboxLiteral = (value: string): string => JSON.stringify(value);

/** Homebrew opt entries are links: Seatbelt also needs the actual library paths. */
export function macosLibraryRoots(): string[] {
  const roots: string[] = [];
  for (const prefix of ["/opt/homebrew", "/usr/local"]) {
    const opt = path.join(prefix, "opt"), cellar = path.join(prefix, "Cellar");
    if (!existsSync(opt) || !existsSync(cellar)) continue;
    const entries = readdirSync(opt);
    if (entries.length > 512) throw new Error("The Homebrew runtime library list exceeds 512 entries.");
    const resolvedCellar = realpathSync(cellar);
    for (const entry of entries) {
      const lib = path.join(opt, entry, "lib");
      if (!existsSync(lib)) continue;
      const resolved = realpathSync(lib);
      // A link from opt into user data must not grant access to that data.
      if (resolved.startsWith(resolvedCellar + path.sep)) roots.push(lib, resolved);
    }
  }
  return roots;
}

// macOS tool shims read these selectors even when the default toolchain is used.
export const MACOS_TOOL_SELECTORS = [
  "/var/select/sh", "/private/var/select/sh",
  "/var/select/developer_dir", "/private/var/select/developer_dir",
];

/** Permit runtime reads and traversal without exposing ancestor directory contents. */
export function macosReadRules(roots: string[]): string[] {
  const readable = new Set(roots.flatMap(root => {
    const resolved = path.resolve(root);
    return existsSync(resolved) ? [resolved, realpathSync(resolved)] : [resolved];
  }));
  const ancestors = new Set<string>();
  for (const root of readable) {
    for (let parent = path.dirname(root); parent !== "/"; parent = path.dirname(parent)) ancestors.add(parent);
  }
  return [
    // Recent dyld versions open / during startup. A literal grants no descendant reads.
    '(allow file-read* (literal "/"))',
    ...[...ancestors].map(root => `(allow file-read-metadata (literal ${sandboxLiteral(root)}))`),
    ...[...readable].map(root => `(allow file-read* (subpath ${sandboxLiteral(root)}))`),
  ];
}
