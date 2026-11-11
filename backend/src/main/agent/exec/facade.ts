import { randomUUID } from "node:crypto";
import type { ToolDispatcher, ExecutedToolOutput } from "../tool-dispatcher.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { updateAgentProgress } from "../../run/execution-ledger.js";
import { getWorkspaceCodeIndex, type DefinitionMatch, type ReferenceMatch, type CodeSearchMatch } from "../codeintel/code-index.js";
import type { SymbolRange } from "../symbol-index.js";

export const READ_ALLOWLIST = new Set([
  "read_file",
  "search",
  "list_dir",
  "read_input",
  "extract_document",
  "retrieve_knowledge",
  "retrieve_result",
  "code_symbols",
  "code_definition",
  "code_references",
  "search_code",
]);

export interface ReadFacadeOptions {
  parentExecId: string;
  requirementId: string;
  maxCalls?: number;
  allowedPaths?: string[];
  requestId?: string;
}

export interface ReadFacade {
  readFile(path: string, options?: { startLine?: number; maxBytes?: number; cursor?: string; all?: boolean; startByte?: number; endByte?: number }): Promise<{
    content: string;
    complete: boolean;
    nextCursor?: string;
    nextByte?: number;
    digest: string;
    totalBytes: number;
  }>;
  search(query: string, options?: { path?: string; maxResults?: number }): Promise<Array<{
    path: string;
    line: number;
    text: string;
  }>>;
  listDir(path: string, options?: { maxEntries?: number }): Promise<string[]>;
  readInput(id: string, options?: { page?: number }): Promise<{
    text: string;
    pages: number;
  }>;
  extractDocument(filename: string, options?: { pages?: number[] }): Promise<{
    text: string;
  }>;
  retrieveKnowledge(query: string): Promise<Array<{
    filename: string;
    page: number;
    text: string;
  }>>;
  result(id: string, options?: { offset?: number; maxChars?: number }): Promise<{
    content: string;
    nextOffset?: number;
    totalChars?: number;
  }>;
  symbols?(path: string): Promise<SymbolRange[]>;
  definition?(name: string, options?: string | { path?: string; fromPath?: string; kind?: string }): Promise<{
    matches: DefinitionMatch[];
    indexComplete: boolean;
  }>;
  references?(name: string, options?: { path?: string; maxResults?: number }): Promise<{
    matches: ReferenceMatch[];
    precision: "import-filtered" | "workspace-wide";
    indexComplete: boolean;
  }>;
  repoMap?(options?: { budgetTokens?: number; focusFiles?: string[] }): Promise<{
    map: string;
    totalFiles: number;
    indexComplete: boolean;
  }>;
  searchCode?(query: string, options?: number | { path?: string; maxResults?: number }): Promise<{
    results: CodeSearchMatch[];
    indexComplete: boolean;
  }>;
  getDiscoveredDigests(): string[];
  getExecutedTools(): ExecutedToolOutput[];
  getCallCount(): number;
}

export function createReadFacade(
  dispatcher: ToolDispatcher,
  baseContext: ToolExecutionContext,
  options: ReadFacadeOptions,
): ReadFacade {
  const maxCalls = options.maxCalls ?? 20;
  let callCount = 0;
  const executedTools: ExecutedToolOutput[] = [];
  const discoveredDigests = new Set<string>();

  const dispatchAllowed = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ExecutedToolOutput> => {
    if (!READ_ALLOWLIST.has(toolName)) {
      throw new Error(`Tool "${toolName}" is not permitted in read-only Code Mode.`);
    }

    if (callCount >= maxCalls) {
      throw new Error(`Tool call budget exceeded (maximum ${maxCalls} calls per script).`);
    }

    callCount++;
    const callId = randomUUID();
    const callContext: ToolExecutionContext = {
      ...baseContext,
      currentCallId: callId,
    };

    const outputs = await dispatcher.dispatchConcurrent(
      [
        {
          id: callId,
          name: toolName,
          arguments: args,
        },
      ],
      callContext,
    );

    const executed = outputs[0];
    executedTools.push(executed);

    const getPayload = (execOut: ExecutedToolOutput): any => {
      if (execOut.result.resultRef?.resultId && baseContext.resultStore) {
        try {
          const raw = baseContext.resultStore.readResultPayload(execOut.result.resultRef.resultId);
          if (typeof raw === "string") {
            try { return JSON.parse(raw); } catch { return raw; }
          }
          return raw;
        } catch {}
      }
      if (typeof execOut.result.output === "string") {
        let text = execOut.result.output;
        if (text.startsWith("[DURABLE RESULT:")) {
          const newlineIdx = text.indexOf("\n");
          if (newlineIdx !== -1) {
            text = text.slice(newlineIdx + 1).trim();
          }
        }
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      return execOut.result.data;
    };

    const payload = getPayload(executed);

    // Track evidence digest from intermediate result or data
    if (executed.result.resultRef?.storage?.sha256) {
      discoveredDigests.add(executed.result.resultRef.storage.sha256);
    }
    const dataDigest = payload?.digest ?? (executed.result.data as { digest?: string } | undefined)?.digest;
    if (dataDigest) {
      discoveredDigests.add(dataDigest);
    }

    // Record action into Agent progress ledger
    try {
      if (baseContext.runId) {
        updateAgentProgress(baseContext.runId, (state) => {
          state.actions.push({
            id: callId,
            hash: callId.slice(0, 8),
            requirementId: options.requirementId,
            operation: toolName,
            status: executed.result.ok ? "completed" : "failed",
            resultId: executed.result.resultRef?.resultId,
            parentExecId: options.parentExecId,
          });

          // If this was a successful read_file with receipt info, also append to state.reads
          if (toolName === "read_file" && executed.result.ok && executed.result.resultRef) {
            const digest = payload?.digest ?? executed.result.resultRef.storage?.sha256;
            if (digest) {
              state.reads.push({
                path: String(args.path ?? payload?.path ?? ""),
                digest,
                startByte: payload?.startByte ?? 0,
                endByte: payload?.endByte ?? payload?.content?.length ?? executed.result.output.length,
                sizeBytes: payload?.sizeBytes ?? payload?.totalBytes ?? executed.result.output.length,
                resultId: executed.result.resultRef.resultId,
                requestId: options.requestId ?? callId,
              });
            }
          }
        });
      }
    } catch {
      // Best-effort ledger tracking in test / non-persisted contexts
    }

    return executed;
  };

  const getToolPayload = (execOut: ExecutedToolOutput): any => {
    if (execOut.result.resultRef?.resultId && baseContext.resultStore) {
      try {
        const raw = baseContext.resultStore.readResultPayload(execOut.result.resultRef.resultId);
        if (typeof raw === "string") {
          try { return JSON.parse(raw); } catch { return raw; }
        }
        return raw;
      } catch {}
    }
    if (typeof execOut.result.output === "string") {
      let text = execOut.result.output;
      if (text.startsWith("[DURABLE RESULT:")) {
        const newlineIdx = text.indexOf("\n");
        if (newlineIdx !== -1) {
          text = text.slice(newlineIdx + 1).trim();
        }
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return execOut.result.data;
  };

  return {
    async readFile(relPath: string, opts?: { startLine?: number; maxBytes?: number; cursor?: string; all?: boolean; startByte?: number; endByte?: number }) {
      if (!relPath || typeof relPath !== "string") {
        throw new Error("readFile requires a non-empty string path argument.");
      }

      if (options.allowedPaths && options.allowedPaths.length > 0) {
        const normalized = relPath.replace(/^\.\//, "");
        const isAllowed = options.allowedPaths.some(
          (p) => p === relPath || p === normalized || p.endsWith(normalized),
        );
        if (!isAllowed) {
          throw new Error(`Path "${relPath}" is outside the allowed read scope: ${options.allowedPaths.join(", ")}`);
        }
      }

      // If caller explicitly passes startLine, cursor, maxBytes, or all === false, perform a single-page read
      const explicitPage = opts?.cursor !== undefined || opts?.startLine !== undefined || opts?.maxBytes !== undefined || opts?.all === false;
      if (explicitPage) {
        const args: Record<string, unknown> = {
          path: relPath,
        };
        if (opts?.startLine !== undefined) args.start_line = opts.startLine;
        if (opts?.maxBytes !== undefined) args.max_bytes = opts.maxBytes;
        if (opts?.cursor !== undefined) args.cursor = opts.cursor;

        const out = await dispatchAllowed("read_file", args);
        if (!out.result.ok) {
          throw new Error(out.result.error?.message || `readFile failed for ${relPath}`);
        }

        const d = getToolPayload(out);
        const content = typeof d?.content === "string" ? d.content : out.result.output;
        const digest = d?.digest ?? out.result.resultRef?.storage?.sha256 ?? "";
        return {
          content,
          complete: d?.complete ?? true,
          nextCursor: d?.nextCursor,
          nextByte: d?.endByte,
          digest,
          totalBytes: d?.sizeBytes ?? d?.totalBytes ?? content.length,
        };
      }

      // Default: sequentially assemble complete file pages up to safe limit (50 pages / ~200KB)
      let fullContent = "";
      let currentCursor: string | undefined = undefined;
      let lastDigest = "";
      let totalBytes = 0;
      let pages = 0;
      const MAX_PAGES = 50;

      while (pages < MAX_PAGES) {
        pages++;
        const args: Record<string, unknown> = { path: relPath };
        if (currentCursor) args.cursor = currentCursor;

        const out = await dispatchAllowed("read_file", args);
        if (!out.result.ok) {
          throw new Error(out.result.error?.message || `readFile failed for ${relPath}`);
        }

        const d = getToolPayload(out);
        const chunk = typeof d?.content === "string" ? d.content : out.result.output;
        fullContent += chunk;
        if (d?.digest) lastDigest = d.digest;
        if (d?.sizeBytes) totalBytes = d.sizeBytes;

        if (d?.complete || !d?.nextCursor) {
          break;
        }
        currentCursor = d.nextCursor;
      }

      return {
        content: fullContent,
        complete: true,
        digest: lastDigest,
        totalBytes: totalBytes || fullContent.length,
      };
    },

    async search(query: string, opts?: { path?: string; maxResults?: number }) {
      if (!query || typeof query !== "string") {
        throw new Error("search requires a non-empty string query argument.");
      }

      const args: Record<string, unknown> = {
        query,
      };
      if (opts?.path) args.path = opts.path;

      const out = await dispatchAllowed("search", args);
      if (!out.result.ok) {
        throw new Error(out.result.error?.message || `search failed for "${query}"`);
      }

      const parsed = getToolPayload(out);
      const matches = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.matches)
        ? parsed.matches
        : null;
      if (matches) {
        const max = opts?.maxResults ?? 50;
        return matches.slice(0, max);
      }

      return [{ path: opts?.path ?? ".", line: 1, text: out.result.output }];
    },

    async listDir(relPath: string, opts?: { maxEntries?: number }) {
      const args: Record<string, unknown> = {
        path: relPath || ".",
      };

      const out = await dispatchAllowed("list_dir", args);
      if (!out.result.ok) {
        throw new Error(out.result.error?.message || `listDir failed for "${relPath}"`);
      }

      const parsed = getToolPayload(out);
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.entries)
        ? parsed.entries
        : null;
      if (entries) {
        const names = entries.map((item: any) =>
          typeof item === "string" ? item : (item?.name ?? String(item)),
        );
        const max = opts?.maxEntries ?? 100;
        return names.slice(0, max);
      }

      return out.result.output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    },

    async readInput(id: string, opts?: { page?: number }) {
      const args: Record<string, unknown> = {
        source_id: id,
      };
      if (opts?.page !== undefined) args.page = opts.page;

      const out = await dispatchAllowed("read_input", args);
      if (!out.result.ok) {
        throw new Error(out.result.error?.message || `readInput failed for "${id}"`);
      }

      const d = out.result.data as { pages?: number } | undefined;
      return {
        text: out.result.output,
        pages: d?.pages ?? 1,
      };
    },

    async extractDocument(filename: string, opts?: { pages?: number[] }) {
      const args: Record<string, unknown> = {
        filename,
      };
      if (opts?.pages) args.pages = opts.pages;

      const out = await dispatchAllowed("extract_document", args);
      if (!out.result.ok) {
        throw new Error(out.result.error?.message || `extractDocument failed for "${filename}"`);
      }

      return { text: out.result.output };
    },

    async retrieveKnowledge(query: string) {
      const args: Record<string, unknown> = {
        query,
      };

      const out = await dispatchAllowed("retrieve_knowledge", args);
      if (!out.result.ok) {
        throw new Error(out.result.error?.message || `retrieveKnowledge failed for "${query}"`);
      }

      const payload = getToolPayload(out);
      if (Array.isArray(payload?.chunks) && payload.chunks.length > 0) {
        return payload.chunks.map((c: any) => ({
          filename: c.docId ?? c.filename ?? "knowledge",
          page: c.page ?? 1,
          text: c.text ?? "",
        }));
      }

      if (Array.isArray(payload)) return payload;

      return [{ filename: "knowledge", page: 1, text: out.result.output }];
    },

    async result(id: string, opts?: { offset?: number; maxChars?: number }) {
      const args: Record<string, unknown> = {
        result_id: id,
      };
      if (opts?.offset !== undefined) args.offset = opts.offset;
      if (opts?.maxChars !== undefined) args.max_chars = opts.maxChars;

      const out = await dispatchAllowed("retrieve_result", args);
      if (!out.result.ok) {
        throw new Error(out.result.error?.message || `result failed for "${id}"`);
      }

      const d = out.result.data as { nextOffset?: number; totalChars?: number } | undefined;
      return {
        content: out.result.output,
        nextOffset: d?.nextOffset,
        totalChars: d?.totalChars ?? out.result.output.length,
      };
    },

    async symbols(relPath: string) {
      if (!relPath || typeof relPath !== "string") {
        throw new Error("symbols requires a non-empty string path argument.");
      }
      if (dispatcher.getTool("code_symbols")) {
        const out = await dispatchAllowed("code_symbols", { path: relPath });
        if (!out.result.ok) throw new Error(out.result.error?.message || `symbols failed for "${relPath}"`);
        const payload = getToolPayload(out);
        if (Array.isArray(payload?.symbols)) return payload.symbols;
        if (Array.isArray(payload)) return payload;
      } else {
        if (callCount >= maxCalls) throw new Error(`Tool call budget exceeded (maximum ${maxCalls} calls per script).`);
        callCount++;
      }
      return getWorkspaceCodeIndex(baseContext.workspaceRoot).symbols(relPath);
    },

    async definition(name: string, opts?: string | { path?: string; fromPath?: string; kind?: string }) {
      if (!name || typeof name !== "string") {
        throw new Error("definition requires a non-empty string symbol name.");
      }
      const pathOpt = typeof opts === "string" ? opts : opts?.path;
      const fromPath = typeof opts === "object" ? opts?.fromPath : undefined;
      const kind = typeof opts === "object" ? opts?.kind : undefined;
      if (dispatcher.getTool("code_definition")) {
        const args: Record<string, unknown> = { name };
        if (pathOpt) args.path = pathOpt;
        if (fromPath) args.from_path = fromPath;
        if (kind) args.kind = kind;
        const out = await dispatchAllowed("code_definition", args);
        if (!out.result.ok) throw new Error(out.result.error?.message || `definition failed for "${name}"`);
        const payload = getToolPayload(out);
        if (Array.isArray(payload?.matches)) {
          return { matches: payload.matches, indexComplete: Boolean(payload.indexComplete ?? true) };
        }
      } else {
        if (callCount >= maxCalls) throw new Error(`Tool call budget exceeded (maximum ${maxCalls} calls per script).`);
        callCount++;
      }
      return getWorkspaceCodeIndex(baseContext.workspaceRoot).definition(name, opts);
    },

    async references(name: string, opts?: { path?: string; maxResults?: number }) {
      if (!name || typeof name !== "string") {
        throw new Error("references requires a non-empty string symbol name.");
      }
      if (dispatcher.getTool("code_references")) {
        const args: Record<string, unknown> = { name };
        if (opts?.path) args.path = opts.path;
        if (opts?.maxResults !== undefined) args.max_results = opts.maxResults;
        const out = await dispatchAllowed("code_references", args);
        if (!out.result.ok) throw new Error(out.result.error?.message || `references failed for "${name}"`);
        const payload = getToolPayload(out);
        if (Array.isArray(payload?.matches)) {
          return {
            matches: payload.matches,
            precision: payload.precision ?? "workspace-wide",
            indexComplete: Boolean(payload.indexComplete ?? true),
          };
        }
      } else {
        if (callCount >= maxCalls) throw new Error(`Tool call budget exceeded (maximum ${maxCalls} calls per script).`);
        callCount++;
      }
      return getWorkspaceCodeIndex(baseContext.workspaceRoot).references(name, opts);
    },

    async repoMap(opts?: { budgetTokens?: number; focusFiles?: string[] }) {
      if (callCount >= maxCalls) {
        throw new Error(`Tool call budget exceeded (maximum ${maxCalls} calls per script).`);
      }
      callCount++;
      return getWorkspaceCodeIndex(baseContext.workspaceRoot).repoMap(opts);
    },

    async searchCode(query: string, opts?: number | { path?: string; maxResults?: number }) {
      if (!query || typeof query !== "string") {
        throw new Error("searchCode requires a non-empty string query.");
      }
      const maxResults = typeof opts === "number" ? opts : opts?.maxResults;
      const scopePath = typeof opts === "object" ? opts?.path : undefined;
      if (dispatcher.getTool("search_code")) {
        const args: Record<string, unknown> = { query };
        if (scopePath) args.path = scopePath;
        if (maxResults !== undefined) args.max_results = maxResults;
        const out = await dispatchAllowed("search_code", args);
        if (!out.result.ok) throw new Error(out.result.error?.message || `searchCode failed for "${query}"`);
        const payload = getToolPayload(out);
        if (Array.isArray(payload?.results)) {
          return { results: payload.results, indexComplete: Boolean(payload.indexComplete ?? true) };
        }
      } else {
        if (callCount >= maxCalls) throw new Error(`Tool call budget exceeded (maximum ${maxCalls} calls per script).`);
        callCount++;
      }
      return getWorkspaceCodeIndex(baseContext.workspaceRoot).searchCode(query, opts);
    },

    getDiscoveredDigests() {
      return Array.from(discoveredDigests);
    },

    getExecutedTools() {
      return executedTools;
    },

    getCallCount() {
      return callCount;
    },
  };
}
