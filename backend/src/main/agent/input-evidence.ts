import { z } from "zod";
import type { IntermediateResultRecord } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { agentEvidenceStore } from "./task-evidence.js";
import { readAgentInputBytes } from "./workspace-actions.js";

export const inputPageSchema=z.object({inputPage:z.literal(true),sourceId:z.string(),filename:z.string(),digest:z.string(),startByte:z.number().int().nonnegative(),endByte:z.number().int().nonnegative(),sizeBytes:z.number().int().nonnegative(),content:z.string(),complete:z.boolean()}).passthrough();

/** Task-authorized pages must match a currently bound input and its pinned bytes. */
export function currentAgentInputPage(context:ToolExecutionContext,record:IntermediateResultRecord) {
  if(record.producer.tool!=="read_input" || record.origin!=="source_extracted" || record.status!=="complete" || record.storage.encoding!=="json" || record.storage.sizeBytes>32768)return;
  try {
    const store=agentEvidenceStore(context,record.resultId), page=inputPageSchema.parse(JSON.parse(store.readResultPayload(record.resultId)));
    const {source,bytes}=readAgentInputBytes(context,page.sourceId);
    if(page.filename!==source.filename || page.digest!==source.sha256 || page.sizeBytes!==bytes.length || page.endByte<page.startByte || page.endByte>bytes.length || page.complete!==(page.startByte===0 && page.endByte===bytes.length) || !bytes.subarray(page.startByte,page.endByte).equals(Buffer.from(page.content)))return;
    return page;
  } catch { return; }
}
