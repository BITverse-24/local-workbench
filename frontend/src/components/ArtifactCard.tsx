import React, { useState, useCallback, useMemo } from "react";
import * as wb from "../lib/workbench";

export type ArtifactCardProps = {
  artifact: ArtifactRef;
  onSave?: (artifact: ArtifactRef) => void;
};

const KEYWORDS = new Set([
  "if", "else", "for", "while", "return", "function", "class", "const", "let", "var",
  "import", "export", "from", "as", "async", "await", "try", "catch", "finally", "throw",
  "new", "this", "super", "extends", "implements", "interface", "enum", "type", "public",
  "private", "protected", "static", "def", "elif", "except", "lambda", "with", "pass",
  "raise", "global", "assert", "and", "or", "not", "is", "print", "self", "None", "True", "False",
  "int", "float", "str", "list", "dict", "bool", "SELECT", "FROM", "WHERE", "JOIN", "ORDER", "BY"
]);

function highlightCode(code: string): React.ReactNode[] {
  const pattern = new RegExp(
    '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`|//.*|#.*|/\\*[\\s\\S]*?\\*/|\\b(?:' +
      Array.from(KEYWORDS).join("|") +
      ")\\b|\\b\\d+\\.?\\d*\\b)",
    "g"
  );
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = pattern.exec(code)) !== null) {
    if (m.index > lastIndex) nodes.push(code.slice(lastIndex, m.index));
    const token = m[0];
    if (!token) {
      lastIndex = pattern.lastIndex;
      continue;
    }
    if (token.startsWith('"') || token.startsWith("'") || token.startsWith("`")) {
      nodes.push(<span key={`s-${idx++}`} className="text-emerald-300">{token}</span>);
    } else if (token.startsWith("//") || token.startsWith("#") || token.startsWith("/*")) {
      nodes.push(<span key={`c-${idx++}`} className="text-zinc-500 italic">{token}</span>);
    } else if (/^\d/.test(token)) {
      nodes.push(<span key={`n-${idx++}`} className="text-amber-300">{token}</span>);
    } else if (KEYWORDS.has(token)) {
      nodes.push(<span key={`k-${idx++}`} className="text-sky-300 font-medium">{token}</span>);
    } else {
      nodes.push(token);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < code.length) nodes.push(code.slice(lastIndex));
  if (nodes.length === 0) return [code];
  return nodes;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getBadgeStyle(kind: string, filename?: string): { label: string; badgeClass: string; iconColor: string } {
  const ext = (filename?.split(".").pop() || kind).toLowerCase();
  switch (ext) {
    case "py":
      return { label: "PYTHON", badgeClass: "bg-sky-500/15 text-sky-400 border-sky-500/30", iconColor: "text-sky-400" };
    case "docx":
    case "doc":
      return { label: "WORD", badgeClass: "bg-blue-500/15 text-blue-400 border-blue-500/30", iconColor: "text-blue-400" };
    case "pdf":
      return { label: "PDF", badgeClass: "bg-rose-500/15 text-rose-400 border-rose-500/30", iconColor: "text-rose-400" };
    case "xlsx":
    case "xls":
      return { label: "EXCEL", badgeClass: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", iconColor: "text-emerald-400" };
    case "csv":
      return { label: "CSV", badgeClass: "bg-teal-500/15 text-teal-400 border-teal-500/30", iconColor: "text-teal-400" };
    case "json":
      return { label: "JSON", badgeClass: "bg-amber-500/15 text-amber-400 border-amber-500/30", iconColor: "text-amber-400" };
    case "md":
      return { label: "MARKDOWN", badgeClass: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30", iconColor: "text-indigo-400" };
    default:
      return { label: kind.toUpperCase() || "FILE", badgeClass: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30", iconColor: "text-zinc-400" };
  }
}

function parseCsv(raw: string): { headers: string[]; rows: string[][] } {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const splitRow = (line: string): string[] => {
    const result: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (c === "," && !inQuotes) {
        result.push(cur.trim());
        cur = "";
      } else {
        cur += c;
      }
    }
    result.push(cur.trim());
    return result;
  };
  const headers = splitRow(lines[0]);
  const rows = lines.slice(1).map(splitRow);
  return { headers, rows };
}

export default function ArtifactCard({ artifact, onSave }: ArtifactCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(artifact.content ?? null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"code" | "table">(artifact.kind === "csv" ? "table" : "code");

  const badge = useMemo(() => getBadgeStyle(artifact.kind, artifact.filename), [artifact.kind, artifact.filename]);
  const fileExt = (artifact.filename?.split(".").pop() || artifact.kind).toLowerCase();
  const isTextLike = ["py", "csv", "json", "txt", "md"].includes(fileExt) || artifact.isBinary === false;

  const handleToggleExpand = useCallback(async () => {
    if (!expanded && isTextLike && content === null) {
      setLoading(true);
      try {
        const full = await wb.getArtifact({ runId: artifact.runId, artifactId: artifact.artifactId });
        if (full?.content) {
          setContent(full.content);
        }
      } catch (err) {
        console.error("Failed to load artifact content:", err);
      } finally {
        setLoading(false);
      }
    }
    setExpanded((prev) => !prev);
  }, [expanded, isTextLike, content, artifact.runId, artifact.artifactId]);

  const handleCopy = useCallback(async () => {
    try {
      if (wb.isWorkbenchAvailable()) {
        const res = await wb.copyArtifact({ runId: artifact.runId, artifactId: artifact.artifactId });
        setCopied(true);
        setCopyFeedback(res?.mode === "file" ? "File copied!" : "Content copied!");
      } else if (content) {
        await navigator.clipboard.writeText(content);
        setCopied(true);
        setCopyFeedback("Content copied!");
      } else {
        await navigator.clipboard.writeText(artifact.filename);
        setCopied(true);
        setCopyFeedback("Filename copied!");
      }
    } catch {
      // Fallback
      if (content) {
        try {
          await navigator.clipboard.writeText(content);
          setCopied(true);
          setCopyFeedback("Content copied!");
        } catch {
          setCopyFeedback("Copy failed");
        }
      }
    }
    setTimeout(() => {
      setCopied(false);
      setCopyFeedback(null);
    }, 2000);
  }, [artifact.runId, artifact.artifactId, artifact.filename, content]);

  const handleSave = useCallback(() => {
    if (onSave) {
      onSave(artifact);
    } else {
      void wb.saveArtifact({ runId: artifact.runId, artifactId: artifact.artifactId });
    }
  }, [artifact, onSave]);

  const lines = useMemo(() => (content ? content.split(/\r?\n/) : []), [content]);
  const csvData = useMemo(() => (artifact.kind === "csv" && content ? parseCsv(content) : null), [artifact.kind, content]);

  return (
    <div className="my-2.5 w-full max-w-2xl rounded-xl neu-card border border-[#2E2E2E] bg-[#1A1A1A] overflow-hidden transition-all duration-200 shadow-sm">
      {/* Header bar matching Claude artifact preview */}
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-[#202020] border-b border-[#2A2A2A]">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase border shrink-0 ${badge.badgeClass}`}
          >
            {badge.label}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-white/90 truncate" title={artifact.filename}>
              {artifact.filename}
            </div>
            <div className="text-[10px] text-white/40 truncate">
              {formatSize(artifact.sizeBytes)}
              {lines.length > 0 ? ` • ${lines.length} lines` : ""}
            </div>
          </div>
        </div>

        {/* 3 action buttons: Expand, Copy, Save as */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleToggleExpand}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg neu-button text-xs font-medium text-white/80 hover:text-white transition-colors"
            title={expanded ? "Collapse preview" : "Expand preview"}
          >
            {expanded ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
                <span>Collapse</span>
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                <span>Expand</span>
              </>
            )}
          </button>

          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg neu-button text-xs font-medium text-white/80 hover:text-white transition-colors"
            title={isTextLike ? "Copy file content" : "Copy file"}
          >
            {copied ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-400">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="text-green-400">{copyFeedback ?? "Copied!"}</span>
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3.5" />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>

          <button
            onClick={handleSave}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg neu-button-primary text-xs font-medium transition-colors"
            title="Save file to local disk"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>Save as</span>
          </button>
        </div>
      </div>

      {/* Expanded content area */}
      {expanded && (
        <div className="bg-[#141414] border-t border-[#262626]">
          {loading ? (
            <div className="p-8 text-center text-xs text-white/40">Loading file content...</div>
          ) : isTextLike && content ? (
            <div>
              {/* CSV view toggle bar if applicable */}
              {artifact.kind === "csv" && csvData && (
                <div className="flex items-center justify-between px-3 py-1.5 bg-[#1B1B1B] border-b border-[#262626] text-xs text-white/60">
                  <span>{csvData.rows.length} rows • {csvData.headers.length} columns</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setViewMode("table")}
                      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${viewMode === "table" ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"}`}
                    >
                      Table View
                    </button>
                    <button
                      onClick={() => setViewMode("code")}
                      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${viewMode === "code" ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"}`}
                    >
                      Raw Code
                    </button>
                  </div>
                </div>
              )}

              {/* Table View for CSV */}
              {artifact.kind === "csv" && viewMode === "table" && csvData ? (
                <div className="max-h-80 overflow-auto p-2">
                  <table className="w-full text-left text-xs border-collapse font-mono">
                    <thead>
                      <tr className="border-b border-[#2C2C2C] bg-[#1A1A1A]">
                        {csvData.headers.map((h, hi) => (
                          <th key={hi} className="p-2 font-semibold text-white/80 whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {csvData.rows.map((row, ri) => (
                        <tr key={ri} className="border-b border-[#222222] hover:bg-[#1C1C1C]">
                          {row.map((cell, ci) => (
                            <td key={ci} className="p-2 text-white/70 whitespace-nowrap">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                /* Line-numbered Code View */
                <div className="max-h-96 overflow-y-auto font-mono text-xs text-white/85 p-3 flex leading-relaxed">
                  {/* Line numbers gutter */}
                  <div className="select-none pr-3 text-right text-zinc-600 shrink-0 border-r border-[#262626]/80 mr-3">
                    {lines.map((_, idx) => (
                      <div key={idx}>{idx + 1}</div>
                    ))}
                  </div>
                  {/* Code body */}
                  <div className="overflow-x-auto whitespace-pre flex-1">
                    {lines.map((line, idx) => (
                      <div key={idx} className="hover:bg-white/[0.02]">
                        {highlightCode(line)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : isTextLike && !content ? (
            <div className="p-6 text-center text-xs text-white/40">File content is empty or unavailable.</div>
          ) : (
            /* Binary File Aesthetic Card */
            <div className="p-5 flex items-center gap-4">
              <div className={`w-12 h-12 rounded-xl grid place-items-center shrink-0 border ${badge.badgeClass}`}>
                <span className="text-xs font-bold">{badge.label.slice(0, 4)}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-white/90">{artifact.filename}</div>
                <div className="text-[11px] text-white/50 mt-0.5">
                  Binary deliverable • {formatSize(artifact.sizeBytes)}
                </div>
                <div className="text-[11px] text-white/40 mt-1">
                  Ready to export. Click <span className="text-white/80 font-medium">Save as</span> to choose a destination folder on your machine or <span className="text-white/80 font-medium">Copy</span> to copy the file to clipboard.
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
