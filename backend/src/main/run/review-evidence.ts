/** Number exact evidence spans so a reviewer need not reproduce code or JSON. */
export function reviewEvidenceCatalog(value: string): string[] {
  return value.split(/\r?\n/).flatMap(line => {
    const spans: string[] = [];
    let remaining = line;
    while (remaining.length > 240) {
      const space = remaining.lastIndexOf(' ', 240);
      const end = space > 120 ? space : 240;
      spans.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
    if (remaining.trim()) spans.push(remaining);
    return spans;
  });
}
export function resolveReviewReferences(indices: unknown, lines: string[], required = false): string[] {
  if (!Array.isArray(indices) || (required && !indices.length) || indices.length > 8 ||
    new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index) || index < 1 || index > lines.length)) {
    // An invalid reference stays ungrounded; it cannot promote another entry.
    return ['\0invalid-evidence-reference'];
  }
  return indices.map(index => lines[index - 1]);
}

/** Imports and prose alone cannot substantiate an implementation behavior. */
export function hasPythonBehaviorEvidence(quotes: string[], requirement: string): boolean {
  const importsRequested = /\b(?:imports?|dependencies|modules?|libraries)\b/i.test(requirement);
  return quotes.some(quote => quote.split(/\r?\n/).some(line => {
    const code=line.trim();
    return Boolean(code && !/^(?:#|["']|FILE\s)/.test(code) && (importsRequested || !/^(?:import\s|from\s)/.test(code)));
  }));
}

/** A positive claim needs evidence of each explicitly named operation.
 * This is an acceptance filter, not a proof that uncited code is defective.
 * Negative findings still need their own grounded review.
 */
export function hasPythonSatisfactionEvidence(quotes: string[], requirement: string): boolean {
  const code = quotes.flatMap(quote => quote.split(/\r?\n/))
    .filter(line => !/^\s*(?:#|["'])/.test(line)).join('\n');
  if (/\b(?:command.line|CLI)\b/i.test(requirement) &&
      !/\b(?:sys\.argv|parse_args|parse_known_args|argparse|click|typer)\b/.test(code)) return false;
  for (const exception of requirement.match(/\b(?:TypeError|ValueError|KeyError)\b/g) ?? []) {
    // A prior input guard may prevent the exception instead of catching it.
    const guard = exception === 'TypeError' ? /\b(?:is\s+not\s+None|is\s+None|isinstance)\b/ : /\bif\b/;
    if (!new RegExp(`\\bexcept\\b[^\\n]*(?:${exception}|Exception|BaseException)\\b|\\bexcept\\s*:`).test(code) && !guard.test(code)) return false;
  }
  return true;
}
