export interface RenderSignaturesOptions {
  hasInputSources?: boolean;
  hasKnowledgeDocs?: boolean;
  hasRetrievableResults?: boolean;
  hasDocumentProcessing?: boolean;
  allowedPaths?: string[];
  fileHints?: string[];
}

/**
 * Generates the compact TypeScript signature block for the read-only Code Mode facade.
 * Kept concise to save model context while providing complete typing and docs.
 */
export function renderReadSignatures(options: RenderSignaturesOptions = {}): string {
  const lines: string[] = [
    "// Read-Only Tool Execution Interface",
    "declare const tools: {",
    "  /** Read file content. Returns {content, complete, digest, totalBytes} */",
    "  readFile(path: string, options?: { startLine?: number; maxBytes?: number; all?: boolean }): Promise<{ content: string; complete: boolean; digest: string; totalBytes: number }>;",
    "  /** Search workspace for pattern. Returns [{path, line, text}] */",
    "  search(query: string, options?: { path?: string; maxResults?: number }): Promise<Array<{ path: string; line: number; text: string }>>;",
    "  /** List entries at workspace path. Returns string[] */",
    "  listDir(path: string, options?: { maxEntries?: number }): Promise<string[]>;"
  ];

  if (options.hasInputSources) {
    lines.push(
      "  /** Read attached input source document by ID. Returns {text, pages} */",
      "  readInput(id: string, options?: { page?: number }): Promise<{ text: string; pages: number }>;"
    );
  }

  if (options.hasDocumentProcessing) {
    lines.push(
      "  /** Extract text from PDF, DOCX, or images. Returns {text} */",
      "  extractDocument(filename: string, options?: { pages?: number[] }): Promise<{ text: string }>;"
    );
  }

  if (options.hasKnowledgeDocs) {
    lines.push(
      "  /** Search indexed knowledge base. Returns [{filename, page, text}] */",
      "  retrieveKnowledge(query: string): Promise<Array<{ filename: string; page: number; text: string }>>;"
    );
  }

  if (options.hasRetrievableResults) {
    lines.push(
      "  /** Retrieve slice of ResultStore item by ID. Returns {content, nextOffset, totalChars} */",
      "  result(id: string, options?: { offset?: number; maxChars?: number }): Promise<{ content: string; nextOffset?: number; totalChars?: number }>;"
    );
  }

  lines.push(
    "};",
    "/** Call text(...) once with final distilled observation (max ~1500 tokens). */",
    "declare function text(value: unknown): void;",
    "/** Escalate to native tool calling if programmatic execution is insufficient. */",
    "declare function escalate(reason: string): never;",
    "",
    "// Built-in Tabular and Analytical Helpers (preloaded in sandbox global scope):",
    "/** Parse CSV text into array of row objects. Headers are mapped to keys. DO NOT call .slice(1) — row [0] is the first data row! */",
    "declare function parseCSV<T = Record<string, any>>(text: string, options?: { delimiter?: string; hasHeader?: boolean; autoTypes?: boolean }): T[];",
    "/** Convert array of row objects to CSV string. */",
    "declare function toCSV(rows: Array<Record<string, any>>, options?: { delimiter?: string; columns?: string[] }): string;",
    "/** Group items by key returned from keyFn. */",
    "declare function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]>;",
    "/** Sum numeric values of array or object property. */",
    "declare function sum(items: number[] | Array<Record<string, any>>, key?: string): number;",
    "/** Average of numeric values. */",
    "declare function avg(items: number[] | Array<Record<string, any>>, key?: string): number;",
    "/** Minimum numeric value. */",
    "declare function min(items: number[] | Array<Record<string, any>>, key?: string): number;",
    "/** Maximum numeric value. */",
    "declare function max(items: number[] | Array<Record<string, any>>, key?: string): number;",
    "/** Sort array by key or selector function. */",
    "declare function sortBy<T>(items: T[], keyOrFn: string | ((item: T) => any), desc?: boolean): T[];",
    "/** Return unique items by primitive identity or key function. */",
    "declare function unique<T>(items: T[], keyFn?: (item: T) => any): T[];",
    "/** Round number to specified decimal places (default 2). */",
    "declare function round(val: number, decimals?: number): number;",
    "/** Split text into lines. */",
    "declare function lines(text: string): string[];",
    "/** Filter lines matching pattern. */",
    "declare function grep(text: string | string[], pattern: string | RegExp): string[];"
  );

  if (options.fileHints && options.fileHints.length > 0) {
    lines.push(
      "",
      "// Available workspace files to inspect with tools.readFile(path):",
      ...options.fileHints
    );
  } else if (options.allowedPaths && options.allowedPaths.length > 0) {
    lines.push(
      "",
      `// Scoped files: ${JSON.stringify(options.allowedPaths.slice(0, 20))}`
    );
  }

  return lines.join("\n");
}
