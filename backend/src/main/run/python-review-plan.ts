import type { ArtifactAcceptanceCheck } from '../../shared/contracts.js';
import { parseStructuredData } from '../gateway/structured-data.js';

const MAX_PLANNED_PYTHON_CHECKS = 7;

/** Only formatting may be ignored when sharing evidence for the same rule. */
export const reviewRequirementKey = (text: string): string => text.trim().replace(/\s+/g, ' ').replace(/[.;]+$/, '');

/** A complete-request aggregate is safe only if exact clauses cover all words.
 * Paraphrased, omitted, or truncated requirements still need an independent review.
 */
export function requestCoveredByCriteria(request: string, criteria: ArtifactAcceptanceCheck[]): boolean {
  const text = request.replace(/\s+/g, ' ').trim();
  if (!text || !criteria.length) return false;
  const covered = new Uint8Array(text.length);
  for (const criterion of criteria) {
    const clause = reviewRequirementKey(criterion.basis);
    if (!clause) continue;
    let start = text.indexOf(clause);
    while (start !== -1) {
      covered.fill(1, start, start + clause.length);
      start = text.indexOf(clause, start + clause.length);
    }
  }
  return [...text].every((char, index) => covered[index] || /^[\s.;]$/.test(char));
}

export interface PythonReviewPlan {
  checks: string[];
  criterionTargets: Map<string, string[]>;
}

/** Build a minimal, deduplicated Python behavior review plan capped at core flow & edge cases. */
export function buildPythonReviewPlan(
  sourceChecklist: string | undefined,
  pythonCriteria: ArtifactAcceptanceCheck[],
): PythonReviewPlan {
  const checklistChecks: string[] = [];
  if (sourceChecklist) {
    try {
      const parsed = parseStructuredData(sourceChecklist) as {
        checks?: unknown[];
        defects?: unknown[];
        preservedBehavior?: unknown[];
      };
      for (const item of [...(parsed.checks ?? []), ...(parsed.defects ?? []), ...(parsed.preservedBehavior ?? [])]) {
        if (typeof item === 'string' && item.trim()) {
          const trimmed = item.trim();
          if (!checklistChecks.some(existing => reviewRequirementKey(existing) === reviewRequirementKey(trimmed))) {
            checklistChecks.push(trimmed);
          }
        }
      }
    } catch {
      /* fall back below */
    }
  }

  const plannedChecks = checklistChecks.slice(0, MAX_PLANNED_PYTHON_CHECKS);
  const preserveFlowCheck = plannedChecks.find(check =>
    /\b(?:original control-flow|preserve successful operations|preserve the return)\b/i.test(check),
  );
  const interfaceCheck = plannedChecks.find(check =>
    /\b(?:public interface|return contract|callable interface)\b/i.test(check),
  );
  const defectChecks = plannedChecks.filter(
    check =>
      check !== preserveFlowCheck &&
      check !== interfaceCheck &&
      (/^(?:Correct this original-source defect|Bug\s*\d*|FIXME)/i.test(check) ||
        /\b(?:defect|bug\s*\d*|fixme|malformed|boundary)\b/i.test(check)),
  );

  const criterionTargets = new Map<string, string[]>();

  for (const criterion of pythonCriteria) {
    const basis = criterion.basis.trim();
    const key = reviewRequirementKey(basis);

    const exact = plannedChecks.find(check => reviewRequirementKey(check) === key);
    if (exact) {
      criterionTargets.set(criterion.id, [exact]);
      continue;
    }

    const numbers = basis.match(/-?\d+(?:\.\d+)?/g) ?? [];
    if (numbers.length > 0) {
      const numericMatches = plannedChecks.filter(check => numbers.every(num => check.includes(num)));
      if (numericMatches.length > 0) {
        criterionTargets.set(criterion.id, numericMatches);
        continue;
      }
    }

    if (
      /\b(?:public interface|return contract|callable interface)\b/i.test(basis) &&
      !/\b(?:command-line|cli|argv)\b/i.test(basis) &&
      interfaceCheck
    ) {
      criterionTargets.set(criterion.id, [interfaceCheck]);
      continue;
    }

    if (
      /\b(?:existing behavior|outside the bugs|still works|other behavior|unmarked|preserve successful)\b/i.test(basis) &&
      preserveFlowCheck
    ) {
      criterionTargets.set(criterion.id, [preserveFlowCheck]);
      continue;
    }

    if (
      /^(?:fix|repair|correct|resolve)\b/i.test(basis) &&
      /\b(?:attached|parser|script|source|code|program|bugs?|classifications?|counting|parsing)\b/i.test(basis) &&
      plannedChecks.length > 0
    ) {
      criterionTargets.set(criterion.id, defectChecks.length > 0 ? defectChecks : [...plannedChecks]);
      continue;
    }

    if (plannedChecks.length < MAX_PLANNED_PYTHON_CHECKS) {
      plannedChecks.push(basis);
      criterionTargets.set(criterion.id, [basis]);
    } else {
      criterionTargets.set(
        criterion.id,
        interfaceCheck && /\b(?:function|callable|interface|keep)\b/i.test(basis)
          ? [interfaceCheck]
          : preserveFlowCheck
            ? [preserveFlowCheck]
            : [...plannedChecks],
      );
    }
  }

  if (!plannedChecks.length) {
    plannedChecks.push('Every defect and behavior required by the request and original source is correctly implemented.');
  }

  return { checks: plannedChecks, criterionTargets };
}
