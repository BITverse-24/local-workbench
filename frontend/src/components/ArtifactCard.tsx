import React, { useState, useCallback, useMemo, useEffect } from "react";
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
  const neutralClass = "bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] border-[var(--border-subtle)]";
  switch (ext) {
    case "py":
      return { label: "Python", badgeClass: neutralClass, iconColor: "text-[var(--text-secondary)]" };
    case "docx":
    case "doc":
      return { label: "Word", badgeClass: neutralClass, iconColor: "text-[var(--text-secondary)]" };
    case "pdf":
      return { label: "PDF", badgeClass: neutralClass, iconColor: "text-[var(--text-secondary)]" };
    case "xlsx":
    case "xls":
      return { label: "Excel", badgeClass: neutralClass, iconColor: "text-[var(--text-secondary)]" };
    case "csv":
      return { label: "CSV", badgeClass: neutralClass, iconColor: "text-[var(--text-secondary)]" };
    case "json":
      return { label: "JSON", badgeClass: neutralClass, iconColor: "text-[var(--text-secondary)]" };
    case "md":
      return { label: "Markdown", badgeClass: neutralClass, iconColor: "text-[var(--text-secondary)]" };
    default:
      return { label: ext.toUpperCase() || "File", badgeClass: neutralClass, iconColor: "text-[var(--text-secondary)]" };
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

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`([^`]+?)`|\[(.+?)\]\((.+?)\)/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIndex) {
      nodes.push(text.slice(lastIndex, m.index));
    }
    if (m[1]) {
      nodes.push(<strong key={`${keyPrefix}-b-${idx++}`} className="font-semibold text-white">{m[1]}</strong>);
    } else if (m[2]) {
      nodes.push(<strong key={`${keyPrefix}-b2-${idx++}`} className="font-semibold text-white">{m[2]}</strong>);
    } else if (m[3]) {
      nodes.push(<em key={`${keyPrefix}-i-${idx++}`} className="italic text-white/90">{m[3]}</em>);
    } else if (m[4]) {
      nodes.push(<em key={`${keyPrefix}-i2-${idx++}`} className="italic text-white/90">{m[4]}</em>);
    } else if (m[5]) {
      nodes.push(<code key={`${keyPrefix}-c-${idx++}`} className="px-1.5 py-0.5 rounded bg-white/10 border border-white/10 text-[11px] font-mono text-amber-200">{m[5]}</code>);
    } else if (m[6] && m[7]) {
      nodes.push(<a key={`${keyPrefix}-a-${idx++}`} href={m[7]} target="_blank" rel="noreferrer" className="underline underline-offset-2 decoration-white/30 hover:decoration-white/60 text-sky-400">{m[6]}</a>);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  if (nodes.length === 0) return [text];
  return nodes;
}

function renderCellContent(text: string, keyPrefix: string): React.ReactNode {
  const trimmed = text.trim();
  const stripped = trimmed.replace(/^[*_`\s]+|[*_`\s]+$/g, "").trim();
  const upper = stripped.toUpperCase();
  if (["APPROVED", "COMPLIANT", "PASS", "PASSED", "CLEARANCE"].includes(upper)) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-[var(--radius-sm)] text-xs font-semibold bg-[var(--status-success)]/15 text-[var(--status-success)] border border-[var(--status-success)]/30">{stripped}</span>;
  }
  if (["NOT APPROVED", "REJECTED", "NON-COMPLIANT", "FAIL", "FAILED", "REJECTION PENDING REPAIRS"].includes(upper)) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-[var(--radius-sm)] text-xs font-semibold bg-[var(--status-error)]/15 text-[var(--status-error)] border border-[var(--status-error)]/30">{stripped}</span>;
  }
  if (["UNKNOWN", "FLAGGED", "WARNING", "RECHECK", "REVISIONS REQUIRED", "PENDING REPAIR", "CONDITIONAL CLEARANCE", "BELOW"].some((k) => upper.includes(k))) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-[var(--radius-sm)] text-xs font-semibold bg-[var(--status-warning)]/15 text-[var(--status-warning)] border border-[var(--status-warning)]/30">{stripped}</span>;
  }
  return renderInline(trimmed, keyPrefix);
}

function parseMarkdownTable(raw: string): { headers: string[]; rows: string[][] } | null {
  const normalized = raw.replace(/(?:^|\n)\s*[-*+]\s+(\|.+?)(?=\r?\n|$)/g, "\n$1");
  const lines = normalized.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const isTableSep = (l: string) => {
    const clean = l.trim().replace(/^[-*+]\s+/, "");
    return /^\s*\|?\s*[-:]+[-| :]*\|?\s*$/.test(clean) && /[-:]{2,}/.test(clean);
  };
  const isTableRow = (l: string) => {
    const clean = l.trim().replace(/^[-*+]\s+/, "");
    return clean.includes("|") && !/^(?:#{1,6}\s|>|```|---|\*\*\*)/.test(clean);
  };

  const sepIdx = lines.findIndex(isTableSep);
  if (sepIdx <= 0) return null;

  const parseRow = (row: string) =>
    row
      .trim()
      .replace(/^[-*+]\s+/, "")
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  const headers = parseRow(lines[sepIdx - 1]);
  const rows: string[][] = [];
  for (let i = sepIdx + 1; i < lines.length; i++) {
    if (isTableRow(lines[i]) && !isTableSep(lines[i])) {
      rows.push(parseRow(lines[i]));
    }
  }
  return rows.length > 0 ? { headers, rows } : null;
}

function InteractiveMarkdown({ text }: { text: string }) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopyCode = useCallback(async (code: string, idx: number) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      }
      setCopiedIndex(idx);
      setTimeout(() => setCopiedIndex(null), 1500);
    } catch {}
  }, []);

  if (!text) return null;
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const segments: Array<{ type: "text" | "code"; content: string; lang?: string }> = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIdx) segments.push({ type: "text", content: text.slice(lastIdx, match.index) });
    segments.push({ type: "code", content: match[2], lang: match[1] });
    lastIdx = codeBlockRegex.lastIndex;
  }
  if (lastIdx < text.length) segments.push({ type: "text", content: text.slice(lastIdx) });
  if (segments.length === 0) segments.push({ type: "text", content: text });

  return (
    <div className="max-h-96 overflow-y-auto p-4 text-xs leading-relaxed space-y-3 font-sans">
      {segments.map((seg, si) => {
        if (seg.type === "code") {
          const isCopied = copiedIndex === si;
          return (
            <div key={`code-${si}`} className="my-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-canvas)] overflow-hidden">
              <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] text-[11px] text-[var(--text-tertiary)] font-mono">
                <span>{seg.lang?.toUpperCase() || "CODE"}</span>
                <button
                  onClick={() => handleCopyCode(seg.content.trim(), si)}
                  className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
                >
                  {isCopied ? "Copied!" : "Copy code"}
                </button>
              </div>
              <pre className="p-3 overflow-x-auto font-mono text-xs leading-relaxed text-[var(--text-primary)]">
                <code>{highlightCode(seg.content.trim())}</code>
              </pre>
            </div>
          );
        }

        const normalizedContent = seg.content
          .replace(/(?:^|\n)\s*[-*+]\s+(\|.+?)(?=\r?\n|$)/g, "\n$1")
          .replace(/([^\n|])\n(\s*\|[^\n]+\|\r?\n\s*\|?[-:\s|]+\|)/g, "$1\n\n$2")
          .replace(/^(#{1,6}\s+[^\n]+)\n(?![\r\n])/gm, "$1\n\n")
          .replace(/(\|[^\n]+\|)\n(?![\r\n|])/g, "$1\n\n");
        const blocks = normalizedContent.split(/\n{2,}/);
        return blocks.map((block, bi) => {
          const trimmed = block.trim();
          if (!trimmed) return null;

          // Table check
          const tableData = parseMarkdownTable(trimmed);
          if (tableData) {
            return (
              <div key={`tbl-${si}-${bi}`} className="my-3 overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)]">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface-raised)]">
                      {tableData.headers.map((h, hi) => (
                        <th key={hi} className="p-2.5 font-medium text-[var(--text-primary)] whitespace-nowrap">
                          {renderInline(h, `th-${si}-${bi}-${hi}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableData.rows.map((row, ri) => (
                      <tr key={ri} className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-surface-raised)]/50 transition-colors">
                        {row.map((cell, ci) => (
                          <td key={ci} className="p-2.5 text-[var(--text-secondary)] align-top">
                            {renderCellContent(cell, `td-${si}-${bi}-${ri}-${ci}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }

          // Horizontal rule
          if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
            return <hr key={`hr-${si}-${bi}`} className="my-4 border-[var(--border-subtle)]" />;
          }

          // Heading
          if (/^#{1,6}\s/.test(trimmed) && !trimmed.includes("\n")) {
            const level = trimmed.match(/^#+/)![0].length;
            const headingContent = trimmed.replace(/^#+\s+/, "");
            const headingStyles: Record<number, string> = {
              1: "text-base font-semibold text-[var(--text-primary)] border-b border-[var(--border-subtle)] pb-1.5 mt-3 mb-2",
              2: "text-[15px] font-semibold text-[var(--text-primary)] mt-3 mb-1.5",
              3: "text-sm font-semibold text-[var(--text-primary)] mt-2.5 mb-1",
              4: "text-xs font-semibold text-[var(--text-secondary)] mt-2 mb-1",
              5: "text-xs font-semibold text-[var(--text-secondary)]",
              6: "text-xs font-medium text-[var(--text-tertiary)]",
            };
            const Tag = `h${Math.min(level, 6)}` as keyof React.JSX.IntrinsicElements;
            return React.createElement(
              Tag,
              { key: `h-${si}-${bi}`, className: `${headingStyles[level] || "text-sm font-semibold text-[var(--text-primary)]"} leading-tight` },
              ...renderInline(headingContent, `h-${si}-${bi}`)
            );
          }

          // Unordered list
          if (/^(\s*[-*]\s+.+(\n\s*[-*]\s+.+)*)$/.test(trimmed)) {
            const items = trimmed.split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
            return (
              <ul key={`ul-${si}-${bi}`} className="list-disc pl-5 space-y-1 my-1.5 marker:text-[var(--text-tertiary)]">
                {items.map((it, i) => (
                  <li key={i} className="leading-relaxed text-[var(--text-secondary)] break-words">
                    {renderInline(it, `li-${si}-${bi}-${i}`)}
                  </li>
                ))}
              </ul>
            );
          }

          // Ordered list
          if (/^(\s*\d+\.\s+.+(\n\s*\d+\.\s+.+)*)$/.test(trimmed)) {
            const items = trimmed.split("\n").map((l) => l.replace(/^\s*\d+\.\s+/, "").trim()).filter(Boolean);
            return (
              <ol key={`ol-${si}-${bi}`} className="list-decimal pl-5 space-y-1 my-1.5 marker:text-[var(--text-tertiary)]">
                {items.map((it, i) => (
                  <li key={i} className="leading-relaxed text-[var(--text-secondary)] break-words">
                    {renderInline(it, `oli-${si}-${bi}-${i}`)}
                  </li>
                ))}
              </ol>
            );
          }

          // Blockquote
          if (/^>\s?/.test(trimmed)) {
            const quote = trimmed.replace(/^>\s?/gm, "");
            return (
              <blockquote key={`q-${si}-${bi}`} className="border-l-2 border-[var(--border-muted)] bg-[var(--bg-surface-raised)] px-3 py-2 rounded-r-[var(--radius-sm)] my-2 text-xs text-[var(--text-secondary)] italic leading-relaxed">
                {renderInline(quote, `q-${si}-${bi}`)}
              </blockquote>
            );
          }

          // Regular paragraph
          const paragraphLines = trimmed.split("\n");
          return (
            <p key={`p-${si}-${bi}`} className="leading-relaxed text-[var(--text-secondary)] my-1.5 whitespace-pre-wrap break-words">
              {paragraphLines.map((line, li) => (
                <React.Fragment key={li}>
                  {renderInline(line, `p-${si}-${bi}-${li}`)}
                  {li < paragraphLines.length - 1 ? <br /> : null}
                </React.Fragment>
              ))}
            </p>
          );
        });
      })}
    </div>
  );
}

export default function ArtifactCard({ artifact, onSave }: ArtifactCardProps) {
  const fileExt = (artifact.filename?.split(".").pop() || artifact.kind).toLowerCase();
  const isMarkdown = fileExt === "md" || artifact.kind === "md";
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(artifact.content ?? null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"code" | "table" | "markdown">(
    artifact.kind === "csv" ? "table" : isMarkdown ? "markdown" : "code"
  );

  useEffect(() => {
    if (artifact.kind === "csv") setViewMode("table");
    else if (fileExt === "md" || artifact.kind === "md") setViewMode("markdown");
    else setViewMode("code");
  }, [artifact.kind, fileExt]);

  const badge = useMemo(() => getBadgeStyle(artifact.kind, artifact.filename), [artifact.kind, artifact.filename]);
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
    <div className="my-2.5 w-full max-w-2xl rounded-[var(--radius-md)] neu-card border border-[var(--border-subtle)] bg-[var(--bg-surface)] overflow-hidden transition-all duration-200 shadow-sm">
      {/* Header bar matching Claude artifact preview */}
      <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-[var(--bg-surface-raised)] border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span
            className={`px-2 py-0.5 rounded-[var(--radius-sm)] text-xs font-medium border shrink-0 ${badge.badgeClass}`}
          >
            {badge.label}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-[var(--text-primary)] truncate" title={artifact.filename}>
              {artifact.filename}
            </div>
            <div className="text-xs text-[var(--text-tertiary)] truncate">
              {formatSize(artifact.sizeBytes)}
              {lines.length > 0 ? ` • ${lines.length} lines` : ""}
            </div>
          </div>
        </div>

        {/* 3 action buttons: Expand, Copy, Save as */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleToggleExpand}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-sm)] neu-button text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title={expanded ? "Collapse preview" : "Expand preview"}
          >
            {expanded ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
                <span>Collapse</span>
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                <span>Expand</span>
              </>
            )}
          </button>

          <button
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-sm)] neu-button text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            title={isTextLike ? "Copy file content" : "Copy file"}
          >
            {copied ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--status-success)]">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="text-[var(--status-success)]">{copyFeedback ?? "Copied"}</span>
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3.5" />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>

          <button
            onClick={handleSave}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--radius-sm)] neu-button-primary text-xs font-medium transition-colors"
            title="Save file to local disk"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
        <div className="bg-[var(--bg-canvas)] border-t border-[var(--border-subtle)]">
          {loading ? (
            <div className="p-8 text-center text-xs text-[var(--text-tertiary)]">Loading file content...</div>
          ) : isTextLike && content ? (
            <div>
              {/* CSV view toggle bar if applicable */}
              {artifact.kind === "csv" && csvData && (
                <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-surface-raised)] border-b border-[var(--border-subtle)] text-xs text-[var(--text-secondary)]">
                  <span>{csvData.rows.length} rows • {csvData.headers.length} columns</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setViewMode("table")}
                      className={`px-2 py-0.5 rounded-[var(--radius-sm)] text-[11px] font-medium transition-colors ${viewMode === "table" ? "bg-[var(--bg-surface)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"}`}
                    >
                      Table View
                    </button>
                    <button
                      onClick={() => setViewMode("code")}
                      className={`px-2 py-0.5 rounded-[var(--radius-sm)] text-[11px] font-medium transition-colors ${viewMode === "code" ? "bg-[var(--bg-surface)] text-[var(--text-primary)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"}`}
                    >
                      Raw Code
                    </button>
                  </div>
                </div>
              )}

              {/* Markdown view toggle bar if applicable */}
              {isMarkdown && (
                <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--bg-surface-raised)] border-b border-[var(--border-subtle)] text-xs text-[var(--text-secondary)]">
                  <span className="flex items-center gap-1.5 font-medium text-[var(--text-secondary)]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]"></span>
                    Markdown deliverable
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setViewMode("markdown")}
                      className={`px-2 py-0.5 rounded-[var(--radius-sm)] text-[11px] font-medium transition-colors ${viewMode === "markdown" ? "bg-[var(--bg-surface)] text-[var(--text-primary)] font-semibold" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"}`}
                    >
                      Markdown
                    </button>
                    <button
                      onClick={() => setViewMode("code")}
                      className={`px-2 py-0.5 rounded-[var(--radius-sm)] text-[11px] font-medium transition-colors ${viewMode === "code" ? "bg-[var(--bg-surface)] text-[var(--text-primary)] font-semibold" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"}`}
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
                      <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface-raised)]">
                        {csvData.headers.map((h, hi) => (
                          <th key={hi} className="p-2 font-medium text-[var(--text-primary)] whitespace-nowrap">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {csvData.rows.map((row, ri) => (
                        <tr key={ri} className="border-b border-[var(--border-subtle)] hover:bg-[var(--bg-surface-raised)]/50 transition-colors">
                          {row.map((cell, ci) => (
                            <td key={ci} className="p-2 text-[var(--text-secondary)] whitespace-nowrap">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : isMarkdown && viewMode === "markdown" ? (
                <InteractiveMarkdown text={content} />
              ) : (
                /* Line-numbered Code View */
                <div className="max-h-96 overflow-y-auto font-mono text-xs text-[var(--text-primary)] p-3 flex leading-relaxed">
                  {/* Line numbers gutter */}
                  <div className="select-none pr-3 text-right text-[var(--text-tertiary)] shrink-0 border-r border-[var(--border-subtle)] mr-3">
                    {lines.map((_, idx) => (
                      <div key={idx}>{idx + 1}</div>
                    ))}
                  </div>
                  {/* Code body */}
                  <div className="overflow-x-auto whitespace-pre flex-1">
                    {lines.map((line, idx) => (
                      <div key={idx} className="hover:bg-[var(--bg-surface-raised)]/30">
                        {highlightCode(line)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : isTextLike && !content ? (
            <div className="p-6 text-center text-xs text-[var(--text-tertiary)]">File content is empty or unavailable.</div>
          ) : (
            /* Binary File Aesthetic Card */
            <div className="p-5 flex items-center gap-4">
              <div className={`w-12 h-12 rounded-[var(--radius-md)] grid place-items-center shrink-0 border ${badge.badgeClass}`}>
                <span className="text-xs font-medium">{badge.label.slice(0, 4)}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[var(--text-primary)]">{artifact.filename}</div>
                <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
                  Binary deliverable • {formatSize(artifact.sizeBytes)}
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)] mt-1">
                  Ready to export. Click <span className="text-[var(--text-primary)] font-medium">Save as</span> to choose a destination folder on your machine or <span className="text-[var(--text-primary)] font-medium">Copy</span> to copy the file to clipboard.
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
