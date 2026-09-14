import type { DirEntry } from "./tools/list-dir.js";

/**
 * System prompt for workspace mode (HARNESS.md §2, §6).
 * Injected when a workspace is registered.
 *
 * Key design: lazy context. The agent starts with a directory tree only,
 * then decides what to read via tool calls.
 */
export function buildHarnessSystemPrompt(directoryTree: string): string {
  return `You are a coding assistant working inside a user's project directory.

WORKSPACE DIRECTORY TREE:
${directoryTree}

You have five tools to explore, understand, modify, and verify code.

TASK LOOP (follow this sequence — HARNESS.md §6):
1. Call list_dir to see the shape of the project.
2. Call search for likely-relevant filenames/keywords.
3. Call read_file on what you find.
4. Propose a change, call write_file to apply it.
5. Call run_command to execute/verify it.
6. If verification fails, read the error, edit again, re-run.
7. Report what changed, referencing the actual diff/backup.

RULES:
- All paths are relative to the workspace root. NEVER use absolute paths.
- Read files before modifying them — understand the existing code first.
- Do not hardcode file paths — use search to discover them.
- Always verify your changes work by running the relevant test/build command.
- When you write a file, report the diff summary from write_file's output.
- If a file is >200KB, use search instead of read_file.
- YOU HAVE FULL PERMISSION and tool capability to interact with the filesystem (via write_file/read_file) and execute shell commands (via run_command). NEVER claim that you "cannot directly interact with the filesystem", "cannot run code or execute files", or "lack permissions". Always use your tools.`;
}

/**
 * OpenAI function-calling tool definitions for the 5 harness tools.
 * These are passed in the \`tools\` parameter of the chat completions API.
 * Compatible with OpenRouter, Ollama, and all OpenAI-compatible providers.
 */
export const HARNESS_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description:
        "List files and directories in the workspace. Returns names, types (file/directory), and sizes in bytes. Ignores .git, node_modules, venv, etc.",
      parameters: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description:
              'Relative path to list. Defaults to "." (workspace root).',
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read the full content of a file. Rejects files larger than 200KB — use search instead for large files.",
      parameters: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "Relative path to the file to read.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search",
      description:
        "Search for a text pattern across files in the workspace using ripgrep. Returns file paths, line numbers, and matching lines.",
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "The text pattern to search for.",
          },
          path: {
            type: "string",
            description:
              'Relative path to search within. Defaults to "." (entire workspace).',
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Write content to a file. Automatically creates a timestamped backup of the existing file before overwriting. Creates parent directories if needed. Returns a diff summary.",
      parameters: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "Relative path to write to.",
          },
          content: {
            type: "string",
            description: "The complete file content to write.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_command",
      description:
        "Execute a shell command with the workspace directory as the working directory. Returns stdout, stderr, and exit code. 60-second timeout.",
      parameters: {
        type: "object" as const,
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
      },
    },
  },
];

/**
 * Format a directory tree listing for injection into the system prompt.
 * Only names and types — no content (HARNESS.md §2: lazy context).
 */
export function formatTreeForPrompt(entries: DirEntry[]): string {
  if (entries.length === 0) return "(empty directory)";
  return entries
    .map((e) => {
      const prefix = e.type === "directory" ? "📁 " : "   ";
      const size = e.type === "file" ? ` (${formatBytes(e.size)})` : "";
      return `${prefix}${e.name}${size}`;
    })
    .join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
