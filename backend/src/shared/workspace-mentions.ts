export interface WorkspaceReference { path: string; kind: "file" | "directory" }
export interface MentionQuery { start: number; end: number; query: string }

export function formatWorkspaceMention(path: string, kind: WorkspaceReference["kind"] = "file"): string {
  const value = path.replace(/\\/g, "/").replace(/\/$/, "") + (kind === "directory" ? "/" : "");
  return /[\s"@]/u.test(value) ? `@${JSON.stringify(value)}` : `@${value}`;
}

export function parseWorkspaceMentions(text: string): WorkspaceReference[] {
  const references = new Map<string, WorkspaceReference>();
  const pattern = /(?:^|\s)@("(?:\\.|[^"\\])*"|[^\s"<>]+)/gu;
  for (const match of text.matchAll(pattern)) {
    let value = match[1];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { continue; }
    } else value = value.replace(/[),;!?]+$/, "");
    if (!value) continue;
    const kind = value.endsWith("/") ? "directory" : "file";
    const path = value.replace(/\/$/, "");
    references.set(path, { path, kind });
  }
  return [...references.values()];
}

export function workspaceMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@("[^"\n]*|[^\s"<>]*)$/u.exec(before);
  if (!match) return null;
  return { start: caret - match[1].length - 1, end: caret, query: match[1].replace(/^"/, "") };
}
