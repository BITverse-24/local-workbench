import { memo, useMemo } from "react";
import { summarizeVerificationReport, type FormattedVerificationCheck } from "../lib/verification-summary";

type Props = {
  report?: RunVerificationReport | null;
};

function CheckStatusBadge({ status }: { status: FormattedVerificationCheck["status"] }) {
  if (status === "passed") {
    return (
      <span
        aria-label="Passed"
        className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--status-success)]/15 text-[10px] font-bold text-[var(--status-success)]"
      >
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        aria-label="Failed"
        className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--status-error)]/15 text-[10px] font-bold text-[var(--status-error)]"
      >
        ✕
      </span>
    );
  }
  return (
    <span
      aria-label={status}
      className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--status-warning)]/15 text-[10px] font-bold text-[var(--status-warning)]"
    >
      !
    </span>
  );
}

function CheckRow({ item }: { item: FormattedVerificationCheck }) {
  return (
    <li className="flex items-start gap-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-canvas)]/60 px-2.5 py-2 border border-[var(--border-subtle)]/70">
      <CheckStatusBadge status={item.status} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center rounded-[4px] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
            {item.typeLabel}
          </span>
          <span className="text-xs font-medium text-[var(--text-primary)] break-words">
            {item.requirement}
          </span>
        </div>
        {item.reason && (
          <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)] break-words">
            {item.reason}
          </p>
        )}
      </div>
    </li>
  );
}

const VerificationSummaryCard = memo(function VerificationSummaryCard({ report }: Props) {
  const summary = useMemo(() => summarizeVerificationReport(report), [report]);
  if (!summary) return null;

  const allPassed = summary.failed === 0 && summary.unverified === 0;

  return (
    <section
      className="w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3.5 select-text"
      aria-label="Assessed verification checks"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            aria-hidden="true"
            className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
              allPassed
                ? "bg-[var(--status-success)]/15 text-[var(--status-success)] border border-[var(--status-success)]/30"
                : "bg-[var(--status-warning)]/15 text-[var(--status-warning)] border border-[var(--status-warning)]/30"
            }`}
          >
            {allPassed ? "✓" : "!"}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[var(--text-primary)]">
              Assessed Checks · {summary.headline}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {summary.categories.map(cat => (
            <span
              key={cat.category}
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--bg-surface-raised)] border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] tabular-nums"
            >
              <span>{cat.label}</span>
              <span className="font-mono text-[10px] text-[var(--text-tertiary)]">
                {cat.passed}/{cat.total}
              </span>
            </span>
          ))}
        </div>
      </div>

      {summary.attentionChecks.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          <p className="text-[11px] font-medium text-[var(--text-secondary)]">Needs attention</p>
          <ul className="space-y-1.5" aria-label="Checks needing attention">
            {summary.attentionChecks.map(item => (
              <CheckRow key={item.criterionId} item={item} />
            ))}
          </ul>
        </div>
      )}

      {summary.passedChecks.length > 0 && (
        <details className="group mt-2.5">
          <summary className="cursor-pointer list-none select-none text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] inline-flex items-center gap-1.5">
            <span className="transition-transform group-open:rotate-90 text-[10px] text-[var(--text-tertiary)]" aria-hidden="true">
              ▸
            </span>
            <span>
              {summary.attentionChecks.length > 0
                ? `Show ${summary.passedChecks.length} passed ${summary.passedChecks.length === 1 ? "check" : "checks"}`
                : `Show all ${summary.passedChecks.length} assessed ${summary.passedChecks.length === 1 ? "check" : "checks"}`}
            </span>
          </summary>
          <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1" aria-label="Passed checks">
            {summary.passedChecks.map(item => (
              <CheckRow key={item.criterionId} item={item} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
});

export default VerificationSummaryCard;
