export interface SmartTruncateOptions {
  maxChars?: number;
}

/**
 * Intelligently truncates model observation payloads (strings, tabular data, arrays, objects)
 * to stay strictly within character/token limits without truncating mid-JSON or losing essential structure.
 */
export function smartTruncate(value: unknown, options: SmartTruncateOptions = {}): string {
  const maxChars = options.maxChars ?? 6000;

  // Handle null / undefined
  if (value === null || value === undefined) {
    return String(value);
  }

  // Fast path: string already under limit
  if (typeof value === "string") {
    if (value.length <= maxChars) {
      return value;
    }

    // Multi-line string (documents, source code, command outputs, logs)
    if (value.includes("\n")) {
      const allLines = value.split("\n");
      if (allLines.length > 10) {
        const headTargetChars = Math.floor(maxChars * 0.65);
        const tailTargetChars = Math.floor(maxChars * 0.25);

        const headLines: string[] = [];
        let headChars = 0;
        for (let i = 0; i < allLines.length; i++) {
          if (headChars + allLines[i].length + 1 > headTargetChars) break;
          headLines.push(allLines[i]);
          headChars += allLines[i].length + 1;
        }

        const tailLines: string[] = [];
        let tailChars = 0;
        for (let i = allLines.length - 1; i >= headLines.length; i--) {
          if (tailChars + allLines[i].length + 1 > tailTargetChars) break;
          tailLines.unshift(allLines[i]);
          tailChars += allLines[i].length + 1;
        }

        const omittedLines = allLines.length - headLines.length - tailLines.length;
        if (omittedLines > 0) {
          const omittedChars = value.length - (headChars + tailChars);
          return [
            headLines.join("\n"),
            `\n... [Omitted ${omittedLines} lines (${omittedChars} chars) to fit output limit] ...\n`,
            tailLines.join("\n"),
          ].join("");
        }
      }
    }

    // Single-line or compact string exceeding maxChars
    const omitted = value.length - maxChars;
    return `${value.slice(0, maxChars)}\n[truncated: ${omitted} chars omitted]`;
  }

  // Tabular data: Array of objects
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
    let fullJson: string;
    try {
      fullJson = JSON.stringify(value, null, 2);
    } catch {
      fullJson = "";
    }
    if (fullJson && fullJson.length <= maxChars) {
      return fullJson;
    }

    const totalRows = value.length;
    const colSet = new Set<string>();
    for (let i = 0; i < Math.min(value.length, 25); i++) {
      if (value[i] && typeof value[i] === "object") {
        for (const k of Object.keys(value[i])) {
          colSet.add(k);
        }
      }
    }
    const columns = Array.from(colSet);

    // Adaptive sample sizing: try 3/2, then 2/1, then 1/1
    const sampleConfigs = [
      { head: Math.min(3, totalRows), tail: totalRows > 3 ? Math.min(2, totalRows - 3) : 0 },
      { head: Math.min(2, totalRows), tail: totalRows > 2 ? Math.min(1, totalRows - 2) : 0 },
      { head: 1, tail: totalRows > 1 ? 1 : 0 },
    ];

    let lastSummary = "";
    for (const config of sampleConfigs) {
      const head = value.slice(0, config.head);
      const tail = config.tail > 0 ? value.slice(totalRows - config.tail) : [];
      const omittedRows = totalRows - config.head - config.tail;

      const parts = [
        `[Tabular Data Preview: showing ${config.head + config.tail} of ${totalRows} rows. Total rows: ${totalRows}]`,
        `Columns (${columns.length}): [ ${columns.map((c) => JSON.stringify(c)).join(", ")} ]`,
        `Sample Head (${config.head} rows):`,
        JSON.stringify(head, null, 2),
      ];
      if (config.tail > 0) {
        parts.push(`Sample Tail (${config.tail} rows):`, JSON.stringify(tail, null, 2));
      }
      if (omittedRows > 0) {
        parts.push(`[${omittedRows} rows omitted to fit token budget. Use code mode filters to query specific subsets]`);
      }

      lastSummary = parts.join("\n");
      if (lastSummary.length <= maxChars) {
        return lastSummary;
      }
    }

    return smartTruncate(lastSummary, { maxChars });
  }

  // Plain Array (primitives or mixed)
  if (Array.isArray(value)) {
    let fullJson: string;
    try {
      fullJson = JSON.stringify(value, null, 2);
    } catch {
      fullJson = "";
    }
    if (fullJson && fullJson.length <= maxChars) {
      return fullJson;
    }

    const totalItems = value.length;
    const sampleConfigs = [
      { head: Math.min(5, totalItems), tail: totalItems > 5 ? Math.min(3, totalItems - 5) : 0 },
      { head: Math.min(3, totalItems), tail: totalItems > 3 ? Math.min(2, totalItems - 3) : 0 },
      { head: 1, tail: totalItems > 1 ? 1 : 0 },
    ];

    let lastSummary = "";
    for (const config of sampleConfigs) {
      const head = value.slice(0, config.head);
      const tail = config.tail > 0 ? value.slice(totalItems - config.tail) : [];
      const omitted = totalItems - config.head - config.tail;

      const parts = [
        `[Array Preview: showing ${config.head + config.tail} of ${totalItems} items. Total items: ${totalItems}]`,
        `Head (${config.head}): ${JSON.stringify(head)}`,
      ];
      if (config.tail > 0) {
        parts.push(`Tail (${config.tail}): ${JSON.stringify(tail)}`);
      }
      if (omitted > 0) {
        parts.push(`[${omitted} items omitted]`);
      }
      lastSummary = parts.join("\n");
      if (lastSummary.length <= maxChars) {
        return lastSummary;
      }
    }

    return smartTruncate(lastSummary, { maxChars });
  }

  // Object with multiple keys
  if (typeof value === "object") {
    let fullJson: string;
    try {
      fullJson = JSON.stringify(value, null, 2);
    } catch {
      fullJson = "";
    }
    if (fullJson && fullJson.length <= maxChars) {
      return fullJson;
    }

    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > 8) {
      const topKeys = keys.slice(0, 6);
      const omittedKeys = keys.slice(6);
      const subset: Record<string, unknown> = {};
      for (const k of topKeys) {
        subset[k] = (value as Record<string, unknown>)[k];
      }
      const parts = [
        `[Object Preview: showing 6 of ${keys.length} keys. Total keys: ${keys.length}]`,
        `All keys: [ ${keys.map((k) => JSON.stringify(k)).join(", ")} ]`,
        `Preview subset:`,
        JSON.stringify(subset, null, 2),
        `[${omittedKeys.length} keys omitted: ${omittedKeys.join(", ")}]`,
      ];
      const summary = parts.join("\n");
      if (summary.length <= maxChars) {
        return summary;
      }
      return smartTruncate(summary, { maxChars });
    }

    // Default object stringification fallback
    const rawObj = fullJson || String(value);
    return smartTruncate(rawObj, { maxChars });
  }

  // Default fallback for numbers, booleans, etc.
  return String(value);
}
