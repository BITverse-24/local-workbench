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
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  let lastBlockEnd = 0;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const lang = (match[1] || "").toLowerCase().trim();
    const blockContent = match[2];
    const startIndex = match.index;
    const precedingText = text.slice(Math.max(lastBlockEnd, startIndex - 300), startIndex);
    lastBlockEnd = startIndex + match[0].length;

    // 0. Terminal/shell commands are NOT source files to write to disk
    if (["bash", "sh", "zsh", "shell", "terminal", "console", "cmd", "powershell"].includes(lang)) {
      continue;
    }

    const trimmedLines = blockContent.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
    const looksLikeTerminalCommand =
      trimmedLines.length <= 4 &&
      trimmedLines.every(
        (l) =>
          /^(node|npm|npx|pnpm|yarn|python|python3|pip|pip3|git|cd|cat|ls|curl|docker|sh|bash)\b/.test(l.trim()) ||
          l.trim().startsWith("$"),
      );
    if (looksLikeTerminalCommand) {
      continue;
    }

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
        // "Here is the updated code for @middleware/rateLimiter.js:", "Code for app.js:", "Update routes/index.js", etc.
        /(?:code\s+(?:for|in)|updated\s+code\s+(?:for|in)|create(?: a)? (?:new )?(?:file|script)?(?: (?:named|called))?|save(?: to)?|file(?:name)?|path:?|update|modify|edit|patch|in|for|to)\s*[:]?\s*[`'"]?@?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]?/i,
        // Header like "### app.js" or "#### routes/products.js"
        /^(?:#{1,6}\s+|(?:\/\/|#)\s+)?[`'"]?@?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]?\s*$/m,
        // Bold filename header like "**app.js**" or "**@middleware/rateLimiter.js**"
        /\*\*[`'"]?@?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]?\*\*/,
        // Parenthesized like "(app.js)" or "(routes/users.js)"
        /\([`'"]?@?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]?\)/,
        // Backticked or quoted filename followed by colon, e.g. `app.js`: or `@middleware/rateLimiter.js`:
        /[`'"]@?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]\s*:/,
        // Pseudo CLI call: write_file --path @middleware/rateLimiter.js
        /write_file\s+(?:--path|-p)?\s*[`'"]?@?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]?/i,
      ];

      for (const rx of precedingPatterns) {
        const flags = rx.flags.includes("g") ? rx.flags : rx.flags + "g";
        const matches = [...precedingText.matchAll(new RegExp(rx.source, flags))];
        if (matches.length > 0) {
          const lastM = matches[matches.length - 1];
          if (lastM && lastM[1] && EXTENSION_REGEX.test(lastM[1]) && !lastM[1].startsWith("http")) {
            foundPath = lastM[1];
            break;
          }
        }
      }
    }

    if (foundPath) {
      // Normalize path
      const cleanPath = foundPath
        .replace(/^@\/?/, "")
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

  // 3. Fallback: Check for pseudo-CLI invocations in text when no code blocks were matched
  // e.g. write_file --path @middleware/rateLimiter.js --content "..."
  if (results.length === 0) {
    const pseudoCliRegex = /write_file\s+(?:--path|-p)\s+[`'"]?@?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)[`'"]?\s+(?:--content|-c)\s+["']([\s\S]*?)["'](?:\s*(?:write_file|$))/gi;
    let cliMatch: RegExpExecArray | null;
    while ((cliMatch = pseudoCliRegex.exec(text)) !== null) {
      const p = cliMatch[1].replace(/^@\/?/, "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
      const c = cliMatch[2];
      if (p && !results.some((r) => r.path === p)) {
        results.push({ path: p, content: c });
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

  // Strip dangling introductory lines preceding stripped code blocks:
  // e.g. "Here is the updated code for @middleware/rateLimiter.js:" or "Here is the code:"
  let cleanedText = cleaned
    .replace(/(?:^|\n)\s*(?:(?:And\s+)?here is the (?:updated\s+)?code\s+(?:for|in)\s+[^\n:]+:?)\s*(?=\n|$)/gi, "")
    .replace(/(?:^|\n)\s*write_file\s+--path\s+[^\n]+/gi, "");

  // Normalize duplicate blank lines and trim
  const normalized = cleanedText
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();

  return normalized || text;
}

/**
 * Sanitizes a model's turn-1 plan preview before presenting it to the user in the confirmation modal:
 * 1. Strips hallucinated tool simulator output like [TOOL_RESULT]...[END_TOOL_RESULT],
 *    <tool_response>...</tool_response>, or <tool_call>...</tool_call>.
 * 2. Strips premature completion markers (e.g. "**Implemented**:", "Next Steps:") which
 *    make no sense in an upfront implementation plan before tools have executed.
 * 3. Strips raw source code blocks that clutter the plan view.
 * 4. Normalizes whitespace and returns a clean, human-readable plan rationale.
 */
export function cleanPlanPreview(text: string): string {
  if (!text) return "";

  // 1. Strip fake tool results like [TOOL_RESULT]...[END_TOOL_RESULT] or <tool_response>...</tool_response>
  let cleaned = text
    .replace(/\[TOOL_RESULT\][\s\S]*?\[END_TOOL_RESULT\]/gi, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");

  // 2. Strip code blocks from plan preview (the actual operations are listed separately)
  cleaned = cleaned.replace(/```[a-zA-Z0-9_-]*\r?\n[\s\S]*?```/g, "");

  // 3. Strip premature "Implemented:" or "Next Steps:" sections that make no sense before tools have run
  cleaned = cleaned.replace(/\*{0,2}Implemented\*{0,2}:?[\s\S]*?(?=\n\s*\*{0,2}(?:Next Steps|Proposed Operations)\*{0,2}|$)/i, "");
  cleaned = cleaned.replace(/\*{0,2}Next Steps\*{0,2}:?[\s\S]*?(?=\n\s*\*{0,2}Proposed Operations\*{0,2}|$)/i, "");

  // 4. Normalize multiple blank lines and trim
  cleaned = cleaned
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

/**
 * Extracts shell commands from markdown code blocks or command lists when the user
 * requested running, installing, building, or testing packages/apps.
 */
export function extractShellCommands(text: string): string[] {
  if (!text) return [];
  const commands: string[] = [];
  const codeBlockRegex = /```(?:bash|sh|zsh|shell|terminal|console|cmd|powershell)?\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const lines = match[1].split(/\r?\n/);
    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("$ ")) {
        line = line.slice(2).trim();
      }
      if (
        /^(npm|npx|node|pnpm|yarn|python|python3|pip|pip3|uv|cargo|make|git|curl|docker|pytest|vitest)\b/.test(
          line,
        )
      ) {
        if (!commands.includes(line)) {
          commands.push(line);
        }
      }
    }
  }

  return commands;
}
