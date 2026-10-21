import type { ArtifactAcceptanceCheck } from '../../shared/contracts.js';

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
