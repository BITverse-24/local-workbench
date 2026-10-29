import path from "node:path";
import { z } from "zod";
import type { AgentRequirement, SourceReadReceipt } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { getExecutionLedger } from "../run/execution-ledger.js";
import { fileDigest, readAgentSourceBytes } from "../harness/tools/edit-file.js";

const pageSchema = z.object({
  sourcePage: z.literal(true), path: z.string(), digest: z.string(),
  startByte: z.number().int().nonnegative(), endByte: z.number().int().nonnegative(), sizeBytes: z.number().int().nonnegative(),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  content: z.string(), complete: z.boolean(), nextCursor: z.string().optional(),
}).strict();
export type AgentSourcePage = z.infer<typeof pageSchema> & { resultId: string };

/** Read complete stored pages only. Partial JSON is never source authority. */
export function loadAgentSourcePage(context: ToolExecutionContext, resultId: string): AgentSourcePage | undefined {
  const store = context.resultStore!, record = store.getResult(resultId);
  if (record.producer.tool !== "read_file" || record.origin !== "source_extracted" || record.storage.encoding !== "json") return;
  const first = store.retrieveResultSlice(resultId, { mode: "text", maxChars: 3000 });
  if (first.totalChars > 12000) return;
  let content = first.content, offset = first.nextOffset;
  while (offset !== undefined) {
    const next = store.retrieveResultSlice(resultId, { mode: "text", offset, maxChars: 3000 });
    content += next.content; offset = next.nextOffset;
  }
  const parsed = pageSchema.safeParse(JSON.parse(content));
  if (!parsed.success) return;
  const page = parsed.data;
  if (page.endByte > page.sizeBytes || page.endByte - page.startByte !== Buffer.byteLength(page.content) ||
      page.complete !== (page.startByte === 0 && page.endByte === page.sizeBytes)) throw new Error("Stored source page has inconsistent byte coverage.");
  return { ...page, resultId };
}

export function sourcePageReceipt(page: AgentSourcePage): Omit<SourceReadReceipt, "requestId"> {
  return { path: page.path, digest: page.digest, startByte: page.startByte, endByte: page.endByte, sizeBytes: page.sizeBytes, resultId: page.resultId };
}

export function sourcePageIsCurrent(context: ToolExecutionContext, page: AgentSourcePage): boolean {
  try { return fileDigest(readAgentSourceBytes(context.workspaceRoot, page.path)) === page.digest; }
  catch { return false; }
}

/** Selection hints affect context only. They establish neither acceptance nor authority. */
export function selectAgentSourcePages(context: ToolExecutionContext, requirement: AgentRequirement, latest: AgentSourcePage | undefined, focus: string, maxChars: number) {
  const progress = getExecutionLedger(context.runId)?.agentProgress;
  const ids = [...new Set([
    ...(progress?.reads.map(read => read.resultId) ?? []),
    ...(progress?.actions.filter(action => action.operation === "read_file" && action.status === "completed").flatMap(action => action.resultId ?? []) ?? []),
  ])].reverse().filter(id => id !== latest?.resultId);
  const currentDigests = new Map<string, string | null>();
  const candidates = ids.flatMap((id, index) => {
    const page = loadAgentSourcePage(context, id);
    if (!page) return [];
    if (!currentDigests.has(page.path)) {
      try { currentDigests.set(page.path, fileDigest(readAgentSourceBytes(context.workspaceRoot, page.path))); }
      catch { currentDigests.set(page.path, null); }
    }
    if (currentDigests.get(page.path) !== page.digest || (latest && page.path === latest.path && page.digest === latest.digest && page.startByte === latest.startByte && page.endByte === latest.endByte)) return [];
    const explicit = requirement.acceptance.some(check => check.path === page.path) || requirement.source.quote.includes(page.path) || requirement.description.includes(page.path);
    const relative = latest ? path.posix.relative(path.posix.dirname(latest.path), page.path) : "";
    const referenced = !!latest && [page.path, relative.startsWith(".") ? relative : `./${relative}`].some(name => latest.content.includes(`"${name}"`) || latest.content.includes(`'${name}'`));
    const sameRequirement = progress?.actions.some(action => action.resultId === id && action.requirementId === requirement.id);
    return [{ page, index, score: (explicit ? 8 : 0) + (referenced || focus.includes(page.path) ? 4 : 0) + (sameRequirement ? 1 : 0) }];
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const pages: AgentSourcePage[] = []; let usedChars = 0;
  const ranges = new Set<string>();
  for (const { page } of candidates) {
    const key = `${page.path}:${page.digest}:${page.startByte}:${page.endByte}`;
    if (ranges.has(key)) continue;
    ranges.add(key);
    const size = JSON.stringify(page).length;
    if (pages.length >= 3 || usedChars + size > maxChars) continue;
    pages.push(page); usedChars += size;
  }
  return { pages, totalEligiblePages: ranges.size, complete: pages.length === ranges.size,
    omittedPagesVia: { tool: "retrieve_result", action: "list" },
    rule: "These are complete observed pages of currently matching source revisions. Page coverage is explicit. Selection does not prove requirement coverage; retrieve omitted pages when needed." };
}
