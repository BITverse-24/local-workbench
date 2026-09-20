import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { listDir } from "../harness/tools/list-dir.js";
import { readFile } from "../harness/tools/read-file.js";
import { search } from "../harness/tools/search.js";
import { writeFile } from "../harness/tools/write-file.js";
import { deleteFile } from "../harness/tools/delete-file.js";
import { runCommand } from "../harness/tools/run-command.js";

export const listDirTool: AgentTool = {
  name: "list_dir",
  definition: {
    type: "function",
    function: {
      name: "list_dir",
      description: "List files and directories in the workspace. Returns names, types, and sizes in bytes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Relative path to list. Defaults to "." (root).' },
        },
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const relPath = typeof args.path === "string" ? args.path : ".";
    const entries = listDir(context.workspaceRoot, relPath);
    // Truncate listing if very large (guard context buffer)
    const truncatedEntries = entries.slice(0, 50);
    const summary = `Listed ${entries.length} items in "${relPath}"${entries.length > 50 ? " (showing first 50)" : ""}`;
    return {
      output: JSON.stringify(truncatedEntries, null, 2),
      summary,
    };
  },
};

export const readFileTool: AgentTool = {
  name: "read_file",
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file content. Large files (>200KB) should be searched via search tool instead.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to file." },
        },
        required: ["path"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const relPath = String(args.path ?? "");
    if (!relPath) throw new Error("path parameter is required");
    const content = readFile(context.workspaceRoot, relPath);
    const lines = content.split("\n");
    let formattedContent = content;
    if (lines.length > 300) {
      // Smart head/tail truncation for prompt budget preservation
      formattedContent = [
        ...lines.slice(0, 150),
        `\n... [TRUNCATED ${lines.length - 250} LINES — use search for specific sections] ...\n`,
        ...lines.slice(-100),
      ].join("\n");
    }
    return {
      output: formattedContent,
      summary: `Read "${relPath}" (${content.length} chars, ${lines.length} lines)`,
    };
  },
};

export const searchTool: AgentTool = {
  name: "search",
  definition: {
    type: "function",
    function: {
      name: "search",
      description: "Search for a text pattern across files in workspace using ripgrep.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The text pattern to search for." },
          path: { type: "string", description: 'Relative path to search within. Defaults to "."' },
        },
        required: ["query"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const query = String(args.query ?? "");
    const relPath = typeof args.path === "string" ? args.path : ".";
    if (!query) throw new Error("query parameter is required");
    const matches = search(context.workspaceRoot, query, relPath);
    const topMatches = matches.slice(0, 30);
    return {
      output: JSON.stringify(topMatches, null, 2),
      summary: `Found ${matches.length} matches for "${query}" in "${relPath}"`,
    };
  },
};

export const writeFileTool: AgentTool = {
  name: "write_file",
  definition: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file. Automatically creates timestamped backup before modifying.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to write to." },
          content: { type: "string", description: "The complete file content." },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const relPath = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (!relPath) throw new Error("path parameter is required");
    const res = writeFile(context.workspaceRoot, relPath, content);
    if (context.harness) {
      try {
        context.harness.createWorkspaceArtifact(context.runId, relPath);
      } catch {}
    }
    return {
      output: JSON.stringify(res),
      summary: `Wrote "${relPath}" (${res.diff ?? "updated"})`,
      sideEffects: [`modified:${relPath}`],
    };
  },
};

export const deleteFileTool: AgentTool = {
  name: "delete_file",
  definition: {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file or directory from the workspace. Automatically creates timestamped backup.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to file or directory to delete." },
        },
        required: ["path"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const relPath = String(args.path ?? "");
    if (!relPath) throw new Error("path parameter is required");
    const res = deleteFile(context.workspaceRoot, relPath);
    return {
      output: JSON.stringify(res),
      summary: `Deleted "${relPath}"`,
      sideEffects: [`deleted:${relPath}`],
    };
  },
};

export const runCommandTool: AgentTool = {
  name: "run_command",
  definition: {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command with workspace directory as cwd. 60-second timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
        },
        required: ["command"],
      },
    },
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const command = String(args.command ?? "");
    if (!command) throw new Error("command parameter is required");
    const res = await runCommand(context.workspaceRoot, command);
    const summary = `Command exit ${res.exitCode} in ${res.durationMs}ms: "${command.slice(0, 40)}"`;
    return {
      output: JSON.stringify(res),
      summary,
      sideEffects: [`executed:${command.slice(0, 30)}`],
    };
  },
};

export const workspaceTools: AgentTool[] = [
  listDirTool,
  readFileTool,
  searchTool,
  writeFileTool,
  deleteFileTool,
  runCommandTool,
];
