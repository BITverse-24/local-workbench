export interface RenderSignaturesOptions {
  hasInputSources?: boolean;
  hasKnowledgeDocs?: boolean;
  hasRetrievableResults?: boolean;
  hasDocumentProcessing?: boolean;
  allowedPaths?: string[];
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
    "// Helpers: parseCSV, toCSV, groupBy, sum, avg, min, max, sortBy, unique, round, lines, grep"
  );

  if (options.allowedPaths && options.allowedPaths.length > 0) {
    lines.push(
      `// Scoped files: ${JSON.stringify(options.allowedPaths.slice(0, 20))}`
    );
  }

  return lines.join("\n");
}
