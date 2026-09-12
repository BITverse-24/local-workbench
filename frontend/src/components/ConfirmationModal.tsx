import React, { useState, useEffect, useCallback, useMemo } from "react";

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
  runState,
  onApprove,
  onReject,
  busy = false,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);

  // Keyboard shortcut listener: Enter to approve, Escape to reject
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onReject();
      } else if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        // Prevent accidental trigger if focus is on an input or button
        const target = e.target as HTMLElement;
        if (target && target.tagName === "BUTTON") return;
        e.preventDefault();
        onApprove();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onApprove, onReject]);

  const expiresIn = useMemo(() => {
    if (!action) return "";
    const ms = Date.parse(action.expiresAt) - Date.now();
    if (ms <= 0) return "expired";
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}:${String(s).padStart(2, "0")} remaining`;
  }, [action]);

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

  const isPython = action.kind === "execute_python";
  const isDocx = action.kind === "generate_docx";

  const kindBadge = isPython ? (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-sky-500/15 text-sky-400 border border-sky-500/30">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
      Python Sandbox Execution
    </span>
  ) : isDocx ? (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-blue-500/15 text-blue-400 border border-blue-500/30">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      DOCX Word Document Generation
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="9" y1="21" x2="9" y2="9" />
      </svg>
      Excel Spreadsheet Generation
    </span>
  );

  const previewLines = action.preview ? action.preview.split(/\r?\n/) : [];

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/75 backdrop-blur-[2px] p-4 sm:p-6 animate-apple-fade">
      <div
        className={`${
          isPython ? "w-[880px] max-w-[94vw]" : "w-[540px] max-w-[94vw]"
        } max-h-[92vh] flex flex-col neu-dropdown p-6 shadow-2xl animate-apple-scaleIn transition-all duration-300 border border-white/10`}
        style={{
          boxShadow: "0 24px 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.08)",
        }}
      >
        {/* Top Header */}
        <div className="flex items-start justify-between gap-4 pb-3 border-b border-white/[0.08] shrink-0">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              {kindBadge}
              <span className="text-[11px] font-mono text-white/40">
                Run {action.runId.slice(0, 8)}
              </span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold text-white/90 leading-snug">
              {action.prompt}
            </h3>
          </div>
          <div className="flex flex-col items-end shrink-0">
            <span className="text-[11px] font-mono px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/10 text-white/60">
              ⏱ {expiresIn}
            </span>
            {runState && (
              <span className="text-[10px] text-white/40 mt-1 uppercase tracking-wider">
                {runState}
              </span>
            )}
          </div>
        </div>

        {/* Script Code Viewport (for execute_python) */}
        {action.preview && (
          <div className="flex-1 flex flex-col min-h-0 mt-4 rounded-xl border border-white/[0.1] bg-[#101010] overflow-hidden shadow-inner">
            {/* Code Window Titlebar */}
            <div className="flex items-center justify-between px-3.5 py-2 bg-white/[0.04] border-b border-white/[0.08] shrink-0">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-red-400/80 inline-block" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400/80 inline-block" />
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/80 inline-block" />
                <span className="text-xs font-mono font-medium text-white/80 ml-2">
                  {isPython ? "task.py" : "output-preview"}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.08] text-white/50 font-mono">
                  {previewLines.length} lines
                </span>
              </div>
              <div className="flex items-center gap-2">
                {isPython && (
                  <button
                    onClick={() => setWrapLines((w) => !w)}
                    className="text-[11px] px-2 py-0.5 rounded neu-button text-white/60 hover:text-white transition-colors font-mono"
                    title="Toggle line wrapping"
                  >
                    Wrap: {wrapLines ? "ON" : "OFF"}
                  </button>
                )}
                <button
                  onClick={handleCopyCode}
                  className="text-[11px] px-2.5 py-0.5 rounded neu-button text-white/70 hover:text-white transition-colors flex items-center gap-1.5"
                  title="Copy full script"
                >
                  {copied ? (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-400">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <span className="text-emerald-400 font-medium">Copied</span>
                    </>
                  ) : (
                    <>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3.5" />
                      </svg>
                      <span>Copy Code</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Scrollable Code Content with Line Numbers */}
            <div className="flex-1 overflow-auto max-h-[440px] min-h-[220px] p-2 select-text font-mono text-[12.5px] leading-relaxed">
              {previewLines.map((line, idx) => (
                <div key={idx} className="flex hover:bg-white/[0.04] rounded-sm group transition-colors">
                  <span className="select-none text-zinc-600 group-hover:text-zinc-400 pr-3.5 pl-2 text-right w-11 shrink-0 text-[11px] font-mono leading-relaxed border-r border-white/[0.06]">
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

            {/* Air-gap Sandbox Security Footer */}
            {isPython && (
              <div className="px-3.5 py-2 bg-emerald-500/[0.06] border-t border-emerald-500/20 text-[11px] text-emerald-400/90 flex items-center gap-2 shrink-0">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400 shrink-0">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
                <span className="font-medium">
                  Sandboxed Execution: Zero network access (<code>--unshare-net</code>) • Read-only inputs • Run-scoped output directory • 60s timeout
                </span>
              </div>
            )}
          </div>
        )}

        {/* Informative text for non-code actions */}
        {!action.preview && (
          <div className="py-4 text-xs text-white/60 leading-relaxed">
            This action requires your confirmation before the workbench creates official deliverables in the run directory.
          </div>
        )}

        {/* Action Controls */}
        <div className="flex items-center justify-between pt-4 mt-2 border-t border-white/[0.08] shrink-0">
          <div className="text-[11px] text-white/40 hidden sm:block">
            Press <kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px] text-white/70">Esc</kbd> to reject, <kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px] text-white/70">Enter</kbd> to approve
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <button
              onClick={onReject}
              disabled={busy}
              className="px-5 py-2 rounded-full neu-button text-xs font-medium text-white/70 hover:text-white hover:border-red-500/40 disabled:opacity-40 transition-colors"
            >
              {busy ? "Working…" : "Reject & Cancel"}
            </button>
            <button
              onClick={onApprove}
              disabled={busy}
              className="px-6 py-2 rounded-full neu-button-primary text-xs font-semibold flex items-center gap-1.5 disabled:opacity-40 shadow-lg"
            >
              {busy ? (
                <>
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-black/40 border-t-black animate-spin" />
                  <span>Processing…</span>
                </>
              ) : isPython ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  <span>Approve & Execute Script</span>
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Approve & Generate</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
