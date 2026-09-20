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

/**
 * Sanitizes the agent's final summary message when tools have already modified the workspace:
 * 1. Strips redundant multi-line source code blocks (javascript, python, json, etc.)
 *    that were already physically written to the workspace disk.
 * 2. Preserves command blocks (sh, bash, zsh) showing next steps / verification.
 * 3. Normalizes whitespace so the user receives a clean, concise, to-the-point summary.
 */
export function cleanFinalSummary(text: string, hasExecutedTools: boolean): string {
  if (!text || !hasExecutedTools) return text;

  // Replace code blocks:
  // - If explicitly tagged with shell/bash/sh/terminal commands, keep them.
  // - If untagged or generic, check if it's a short command list (e.g. `node app.js`, `npm test`).
  // - If it's source code (e.g. JS, TS, JSON, Python, etc.), strip it since files are already on disk.
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  const cleaned = text.replace(codeBlockRegex, (match: string, lang: string, code: string) => {
    const language = (lang || "").toLowerCase().trim();
    // Keep explicit shell command blocks
    if (["sh", "bash", "zsh", "shell", "terminal", "cmd", "powershell"].includes(language)) {
      return match;
    }
    // If tagged with known code or data formats, strip it
    if (
      [
        "javascript", "typescript", "js", "ts", "jsx", "tsx", "json",
        "python", "py", "html", "css", "yaml", "yml", "java", "c",
        "cpp", "go", "rust", "sql", "xml", "markdown", "md", "text", "txt"
      ].includes(language)
    ) {
      // Check if it's actually just shell commands tagged as text
      const trimmed = code.trim();
      const lines = trimmed.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
      const isShellCommand =
        lines.length <= 4 &&
        lines.every(
          (line: string) =>
            /^(npm|npx|node|pnpm|yarn|python|python3|pip|pip3|uv|git|cd|cat|ls|touch|mkdir|curl|docker|sh|bash)\b/.test(
              line.trim(),
            ) || line.trim().startsWith("$"),
        );
      if (isShellCommand) return match;
      return "";
    }
    // Untagged blocks: keep if it looks like shell commands, otherwise strip
    const trimmed = code.trim();
    const lines = trimmed.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
    const looksLikeCommand =
      lines.length <= 4 &&
      lines.every(
        (line: string) =>
          /^(npm|npx|node|pnpm|yarn|python|python3|pip|pip3|uv|git|cd|cat|ls|touch|mkdir|curl|docker|sh|bash)\b/.test(
            line.trim(),
          ) || line.trim().startsWith("$"),
      );
    if (looksLikeCommand) {
      return match;
    }
    return "";
  });

  // Normalize duplicate blank lines and trim
  const normalized = cleaned
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();

  return normalized || text;
}
