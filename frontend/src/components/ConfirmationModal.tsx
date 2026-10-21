import React, { useState, useEffect, useCallback, useMemo } from "react";
import { BasicMarkdown } from "./ChatArea";
import { CONFIRMATION_DESCRIPTIONS, CONFIRMATION_TITLES } from '../../../backend/src/shared/confirmation-presentation.js';

type Props = {
  open: boolean;
  action: PendingAction | null;
  runState: RunState | null;
  onApprove: () => void;
  onReject: () => void;
  onClose: () => void;
  busy?: boolean;
};

const PYTHON_KEYWORDS = new Set([
  "def", "class", "import", "from", "as", "return", "if", "elif", "else",
  "for", "while", "in", "try", "except", "finally", "with", "pass", "break",
  "continue", "raise", "yield", "lambda", "global", "nonlocal", "assert",
  "True", "False", "None", "and", "or", "not", "is", "async", "await"
]);

const PYTHON_BUILTINS = new Set([
  "print", "len", "range", "open", "int", "str", "float", "bool", "list",
  "dict", "set", "tuple", "sum", "min", "max", "enumerate", "zip", "filter",
  "map", "sorted", "reversed", "any", "all", "isinstance", "type", "round",
  "super", "sys", "os", "csv", "json", "math", "re"
]);

function highlightPython(code: string): React.ReactNode[] {
  if (!code) return [" "];
  const pattern = new RegExp(
    '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|#.*|\\b(?:' +
      Array.from(PYTHON_KEYWORDS).join("|") +
      ')\\b|\\b(?:' +
      Array.from(PYTHON_BUILTINS).join("|") +
      ')\\b|\\b\\d+\\.?\\d*\\b)',
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
    if (token.startsWith('"') || token.startsWith("'")) {
      nodes.push(<span key={`s-${idx++}`} className="text-emerald-300">{token}</span>);
    } else if (token.startsWith("#")) {
      nodes.push(<span key={`c-${idx++}`} className="text-zinc-500 italic">{token}</span>);
    } else if (/^\d/.test(token)) {
      nodes.push(<span key={`n-${idx++}`} className="text-amber-300">{token}</span>);
    } else if (PYTHON_KEYWORDS.has(token)) {
      nodes.push(<span key={`k-${idx++}`} className="text-sky-300 font-medium">{token}</span>);
    } else if (PYTHON_BUILTINS.has(token)) {
      nodes.push(<span key={`b-${idx++}`} className="text-violet-300">{token}</span>);
    } else {
      nodes.push(token);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < code.length) nodes.push(code.slice(lastIndex));
  if (nodes.length === 0) return [code];
  return nodes;
}

export default function ConfirmationModal({
  open,
  action,
  onApprove,
  onReject,
  busy = false,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);

  // Keyboard shortcut listener: Enter to approve, Escape to reject
  useEffect(() => {
    if (!open || !action || busy || Date.parse(action.expiresAt) <= Date.now()) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onReject();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (Date.parse(action.expiresAt) <= Date.now()) return;
        // Focused controls handle Enter themselves, including the details toggle.
        const target = e.target as HTMLElement;
        if (target?.closest?.('button, input, textarea, select, summary, a, [contenteditable="true"]')) return;
        e.preventDefault();
        onApprove();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, action, busy, onApprove, onReject]);

  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!open || !action) return;
    setNow(Date.now());
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, [open, action]);

  const expiresIn = useMemo(() => {
    if (!action) return "";
    const ms = Date.parse(action.expiresAt) - now;
    if (ms <= 0) return "expired";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, "0")} remaining`;
  }, [action, now]);

  const handleCopyCode = useCallback(async () => {
    if (!action?.preview) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(action.preview);
      } else {
        const ta = document.createElement("textarea");
        ta.value = action.preview;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [action?.preview]);

  if (!open || !action) return null;

  const isPlan = action.kind === "plan_approval";
  const isUncontainedPython = action.kind === "uncontained_python";
  const isPython = action.kind === "execute_python" || isUncontainedPython;
  const expired = Date.parse(action.expiresAt) <= now;
  const isDocx = action.kind === "generate_docx";
  const title = CONFIRMATION_TITLES[action.kind];

  const kindBadge = (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-sm)] text-xs font-medium bg-[var(--bg-surface-raised)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
      {isPlan ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
          </svg>
          Action plan
        </>
      ) : isPython ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          {isUncontainedPython ? "Python execution without OS isolation" : "Python execution"}
        </>
      ) : isDocx ? (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          Word document generation
        </>
      ) : (
        <>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
          Excel spreadsheet generation
        </>
      )}
    </span>
  );

  const previewLines = action.preview ? action.preview.split(/\r?\n/) : [];

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4 sm:p-6">
      <div
        role="dialog" aria-modal="true" aria-labelledby="confirmation-title"
        className={`${
          isPython ? "w-[880px] max-w-[94vw]" : isPlan ? "w-[760px] max-w-[94vw]" : "w-[540px] max-w-[94vw]"
        } max-h-[92vh] flex flex-col rounded-[var(--radius-md)] neu-panel p-6 border border-[var(--border-subtle)] bg-[var(--bg-surface)]`}
      >
        {/* Top Header */}
        <div className="flex items-start justify-between gap-4 pb-3 border-b border-[var(--border-subtle)] shrink-0">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              {kindBadge}
            </div>
            <h3 id="confirmation-title" className="text-base sm:text-lg font-medium text-[var(--text-primary)] leading-snug">
              {title}
            </h3>
          </div>
          <div className="flex flex-col items-end shrink-0">
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
              ⏱ {expiresIn}
            </span>
          </div>
        </div>

        <p className="mt-4 shrink-0 text-sm leading-relaxed text-[var(--text-secondary)]">
          {CONFIRMATION_DESCRIPTIONS[action.kind]}
        </p>

        {isPlan && action.prompt && action.prompt !== title && <details open className="mt-3 shrink-0 text-xs text-[var(--text-secondary)]">
          <summary className="cursor-pointer font-medium">Action details</summary>
          <p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words select-text rounded-[var(--radius-sm)] border border-[var(--border-subtle)] p-3 leading-relaxed">{action.prompt}</p>
        </details>}

        {/* Script / Plan Preview Viewport */}
        {action.preview && (
          <details key={action.actionId} open={!isPython} className="min-h-0 overflow-auto mt-4">
            <summary className="cursor-pointer text-xs font-medium text-[var(--text-secondary)]">
              {isPython ? 'View script' : isPlan ? 'Action plan' : 'Document preview'}
            </summary>
          <div className="flex-1 flex flex-col min-h-0 mt-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-canvas)] overflow-hidden">
            {/* Code / Plan Window Titlebar */}
            <div className="flex items-center justify-between px-3.5 py-2 bg-[var(--bg-surface-raised)] border-b border-[var(--border-subtle)] shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-medium text-[var(--text-primary)]">
                  {isPlan ? "execution-plan.md" : isPython ? "task.py" : "output-preview"}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface)] text-[var(--text-tertiary)] font-mono border border-[var(--border-subtle)]">
                  {isPlan ? "task plan" : `${previewLines.length} lines`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {isPython && (
                  <button
                    onClick={() => setWrapLines((w) => !w)}
                    className="text-[11px] px-2 py-0.5 rounded-[var(--radius-sm)] neu-button text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors font-mono"
                    title="Toggle line wrapping"
                  >
                    Wrap: {wrapLines ? "ON" : "OFF"}
                  </button>
                )}
                <button
                  onClick={handleCopyCode}
                  className="text-[11px] px-2.5 py-0.5 rounded-[var(--radius-sm)] neu-button text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1.5"
                  title={isPlan ? "Copy full plan" : "Copy full script"}
                >
                  {copied ? (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-[var(--status-success)]">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <span className="text-[var(--status-success)] font-medium">Copied</span>
                    </>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3.5" />
                      </svg>
                      <span>{isPlan ? "Copy plan" : "Copy code"}</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Viewport Content */}
            {isPlan ? (
              <div className="flex-1 overflow-auto max-h-[440px] min-h-[180px] p-4 select-text text-sm leading-relaxed text-[var(--text-primary)]">
                <BasicMarkdown text={action.preview || ""} />
              </div>
            ) : (
              /* Scrollable Code Content with Line Numbers */
              <div className="flex-1 overflow-auto max-h-[440px] min-h-[220px] p-2 select-text font-mono text-xs leading-relaxed text-[var(--text-primary)]">
                {previewLines.map((line, idx) => (
                  <div key={idx} className="flex hover:bg-[var(--bg-surface-raised)]/40 rounded-sm group transition-colors">
                    <span className="select-none text-[var(--text-tertiary)] pr-3.5 pl-2 text-right w-11 shrink-0 text-[11px] font-mono leading-relaxed border-r border-[var(--border-subtle)]">
                      {idx + 1}
                    </span>
                    <span
                      className={`pl-3 pr-2 flex-1 leading-relaxed ${
                        wrapLines ? "break-all whitespace-pre-wrap" : "whitespace-pre"
                      }`}
                    >
                      {isPython ? highlightPython(line) : line || " "}
                    </span>
                  </div>
                ))}
              </div>
            )}

          </div>
          </details>
        )}

        {/* Action Controls */}
        <div className="flex items-center justify-between pt-4 mt-2 border-t border-[var(--border-subtle)] shrink-0">
          <div className="text-[11px] text-[var(--text-tertiary)] hidden sm:block">
            Press <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] font-mono text-[10px] text-[var(--text-secondary)]">Esc</kbd> to reject, <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] font-mono text-[10px] text-[var(--text-secondary)]">Enter</kbd> to approve
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <button
              onClick={onReject}
              disabled={busy}
              className="h-10 px-4 rounded-[var(--radius-sm)] neu-button text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 transition-colors"
            >
              {busy ? "Working…" : "Reject & Cancel"}
            </button>
            <button
              onClick={onApprove}
              disabled={busy || expired}
              className="h-10 px-5 rounded-[var(--radius-sm)] neu-button-primary text-sm font-semibold flex items-center gap-2 disabled:opacity-40 transition-colors"
            >
              {busy ? (
                <>
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-[var(--text-primary)]/40 border-t-[var(--text-primary)] animate-spin" />
                  <span>Processing…</span>
                </>
              ) : isPlan ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Approve plan</span>
                </>
              ) : isPython ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span>Approve & execute script</span>
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Approve & generate</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
