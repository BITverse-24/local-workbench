export interface ExtractedFileBlock {
  path: string;
  content: string;
}

const EXTENSION_REGEX = /\.(js|ts|jsx|tsx|json|py|html|css|md|txt|env|ya?ml|mjs|cjs|sh|bash|sql|svg)$/i;

/**
 * Extracts source code blocks and their target workspace filenames from model markdown text.
 * Handles patterns such as:
 * - `// path/to/file.ext` or `# path/to/file.ext` on the first line of code block
 * - `Create a file named path/to/file.ext` or `File: path/to/file.ext` preceding code block
 * - Preceding headers like `### routes/users.js`
 */
export function extractCodeBlocksWithFilenames(text: string): ExtractedFileBlock[] {
  if (!text) return [];

  const results: ExtractedFileBlock[] = [];
  const codeBlockRegex = /```(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const blockContent = match[1];
    const startIndex = match.index;
    const precedingText = text.slice(Math.max(0, startIndex - 300), startIndex);

    let foundPath: string | null = null;

    // 1. Check first 2 lines of the code block for comment-based path: // app.js or # server.py or /* routes/index.js */
    const lines = blockContent.split(/\r?\n/);
    for (let i = 0; i < Math.min(lines.length, 2); i++) {
      const line = lines[i].trim();
      const commentMatch = line.match(/^(?:\/\/|#|\/\*)\s*[`'"]?([a-zA-Z0-9_\-./\\]+)[`'"]?(?:\s*\*\/)?$/);
      if (commentMatch && EXTENSION_REGEX.test(commentMatch[1])) {
        foundPath = commentMatch[1];
        break;
      }
    }

    // 2. Check preceding text within 300 chars for explicit filename mentions
    if (!foundPath) {
      const precedingPatterns = [
        // "Create a file named app.js" or "file named `routes/users.js`"
        /(?:create|in|into|file(?:name)?|named?|path:?)\s+[`'"]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]?/i,
        // Header like "### app.js" or "#### routes/products.js"
        /^(?:#{1,6}\s+|(?:\/\/|#)\s+)?[`'"]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]?\s*$/m,
        // Parenthesized like "(app.js)" or "(routes/users.js)"
        /\([`'"]?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]?\)/,
      ];

      for (const rx of precedingPatterns) {
        const m = precedingText.match(rx);
        if (m && m[1] && EXTENSION_REGEX.test(m[1]) && !m[1].startsWith("http")) {
          foundPath = m[1];
          break;
        }
      }
    }

    if (foundPath) {
      // Normalize path
      const cleanPath = foundPath
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/^\//, "")
        .trim();

      if (cleanPath && !results.some((r) => r.path === cleanPath)) {
        results.push({
          path: cleanPath,
          content: blockContent,
        });
      }
    }
  }

  return results;
}
