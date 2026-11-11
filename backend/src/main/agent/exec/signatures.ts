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
    "  listDir(path: string, options?: { maxEntries?: number }): Promise<string[]>;",
    "  symbols(path: string): Promise<Array<{ name: string; kind: string; startLine: number; endLine: number; exported?: boolean }>>;",
    "  definition(name: string, scope?: string | { path?: string; fromPath?: string; kind?: string }): Promise<{ matches: any[]; indexComplete: boolean }>;",
    "  references(name: string, opts?: { path?: string; maxResults?: number }): Promise<{ matches: any[]; precision: string; indexComplete: boolean }>;",
    "  repoMap(opts?: { budgetTokens?: number; focusFiles?: string[] }): Promise<{ map: string; totalFiles: number; indexComplete: boolean }>;",
    "  searchCode(query: string, opts?: number | { path?: string; maxResults?: number }): Promise<{ results: any[]; indexComplete: boolean }>;"
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
    "// Built-in Tabular & Analytical Helpers (global scope):",
    "/** Parse CSV into row objects (row [0] is first data row; do not .slice(1)). */",
    "declare function parseCSV<T = Record<string, any>>(text: string, options?: { delimiter?: string; hasHeader?: boolean; autoTypes?: boolean }): T[];",
    "declare function toCSV(rows: Array<Record<string, any>>, options?: { delimiter?: string; columns?: string[] }): string;",
    "declare function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]>;",
    "declare function sum(items: number[] | Array<Record<string, any>>, key?: string): number;",
    "declare function avg(items: number[] | Array<Record<string, any>>, key?: string): number;",
    "declare function min(items: number[] | Array<Record<string, any>>, key?: string): number;",
    "declare function max(items: number[] | Array<Record<string, any>>, key?: string): number;",
    "declare function sortBy<T>(items: T[], keyOrFn: string | ((item: T) => any), desc?: boolean): T[];",
    "declare function unique<T>(items: T[], keyFn?: (item: T) => any): T[];",
    "declare function round(val: number, decimals?: number): number;",
    "declare function lines(text: string): string[];",
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
