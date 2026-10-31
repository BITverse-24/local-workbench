import { agentEvidenceStore } from "./task-evidence.js";
import { z } from "zod";
import type { AgentRequirement, IntermediateResultRecord } from "../../shared/contracts.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { fileDigest, observedRange, readAgentSourceBytes } from "../harness/tools/edit-file.js";
import { canonicalSourcePath } from "./workspace-actions.js";
import { readAgentInputBytes } from "./workspace-actions.js";
import { currentAgentInputPage } from "./input-evidence.js";
import { existsSync } from "node:fs";
import { resolveSafe } from "../harness/path-guard.js";

const pageSchema = z.object({ sourcePage: z.literal(true), path: z.string(), digest: z.string(), startByte: z.number().int().nonnegative(), endByte: z.number().int().nonnegative(), sizeBytes: z.number().int().nonnegative(), content: z.string() });

/** A source quotation is a byte comparison. It is never a test pass or a scope decision. */
export function verifyVerbatimChecks(requirement: AgentRequirement, context: ToolExecutionContext, records: IntermediateResultRecord[], answer: string | Buffer) {
  return requirement.acceptance.filter(check => check.operation === "verbatim_source").map(check => {
    const evidenceIds: string[] = [];
    try {
      const relative = canonicalSourcePath(context, check.path!), inputs=(context.inputSources ?? []).filter(source=>source.filename===check.path);
      const workspaceExists=existsSync(resolveSafe(context.workspaceRoot,relative));
      if(inputs.length>1 || inputs.length && workspaceExists)throw new Error("The source name identifies more than one file. Disambiguate the attached input and workspace source.");
      const attachment=inputs[0], bytes=attachment ? readAgentInputBytes(context,attachment.id).bytes : readAgentSourceBytes(context.workspaceRoot, relative), digest = fileDigest(bytes);
      const ranges: Array<{ path: string; digest: string; startByte: number; endByte: number }> = [];
      for (const record of records) {
        if(attachment) {
          const page=currentAgentInputPage(context,record);
          if(page?.sourceId===attachment.id && page.digest===digest && page.sizeBytes===bytes.length) {ranges.push({path:relative,digest,startByte:page.startByte,endByte:page.endByte});evidenceIds.push(record.resultId);}
          continue;
        }
        if (record.producer.tool !== "read_file" || record.origin !== "source_extracted" || record.status !== "complete" || record.storage.sizeBytes > 32768) continue;
        let text = "", offset: number | undefined = 0;
        while (offset !== undefined) { const page = agentEvidenceStore(context,record.resultId).retrieveResultSlice(record.resultId, { mode: "text", offset, maxChars: 3000 }); text += page.content; offset = page.nextOffset; }
        let value: unknown;
        try { value = JSON.parse(text); } catch { continue; }
        const parsed = pageSchema.safeParse(value);
        if (!parsed.success) continue;
        const page = parsed.data;
        if (page.path !== relative || page.digest !== digest || page.sizeBytes !== bytes.length || page.endByte < page.startByte || page.endByte > bytes.length || !bytes.subarray(page.startByte, page.endByte).equals(Buffer.from(page.content))) continue;
        ranges.push(page); evidenceIds.push(record.resultId);
      }
      if (!ranges.length || !observedRange(ranges, relative, digest, 0, bytes.length)) return { requirementId: requirement.id, checkId: check.id, path: relative, passed: false, needsSource: true, reason: "The complete current source has not been observed.", evidenceIds };
      if (Buffer.isBuffer(answer)) {
        const passed=bytes.equals(answer);
        return { requirementId: requirement.id, checkId: check.id, path: relative, passed, matchForm: passed ? "artifact_bytes" : "none", sourceDigest:digest, sourceBytes:bytes.length,
          reason: passed ? "The saved artifact matches the complete observed source bytes." : "The saved artifact does not match the current source bytes.", evidenceIds };
      }
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const quotes = [...answer.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(match => match[1]);
      const matchedQuote = quotes.some(quote => quote === content), passed = answer === content || matchedQuote;
      return { requirementId: requirement.id, checkId: check.id, path: relative, passed, matchForm: answer === content ? "raw" : matchedQuote ? "fenced_quote" : "none", sourceDigest: digest, sourceBytes: bytes.length,
        reason: passed ? "The answer reproduces the complete observed source bytes." : "The answer must reproduce the current source verbatim, including line endings. Use a complete literal quote.", evidenceIds };
    } catch (error) { return { requirementId: requirement.id, checkId: check.id, path: check.path, passed: false, needsSource: true, reason: String(error), evidenceIds }; }
  });
}
