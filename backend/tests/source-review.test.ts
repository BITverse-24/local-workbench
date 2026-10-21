import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { enforceSourceConditionalPreconditions, findingsTableAlignmentGaps, linkRecommendationsToSubjects, preserveExtractedAnnotations, preserveExtractedFindings, preserveMissingSubjectSections, reviewAttachedPython, reviewProposedPython, unchangedMarkedConditionGaps, unmarkedConditionalUpdateGaps } from "../src/main/agent/source-review.js";
import { runRoot } from "../src/main/run/filesystem.js";
import type { ModelGateway } from "../src/main/gateway/model-gateway.js";
import type { ModelId } from "../src/shared/contracts.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";

function reviewGateway(content: string) {
  return { chatWithTools: vi.fn(async () => ({ ok: true, value: { content, finishReason: "stop" } })) } as unknown as ModelGateway;
}

async function reviewAttachedCode(content: string) {
  const runId = randomUUID();
  try {
    return await reviewAttachedPython({
      gateway: reviewGateway(content), modelId: "primary-model" as ModelId, runId,
      request: "Repair the attached source while preserving its interface.",
      sourceEvidence: "def summarize(path):\n    return read_rows(path)",
      sourceChecklist: JSON.stringify({ checks: ["Preserve the callable interface.", "Return the rows read from the input."] }),
      currentSource: "def summarize(path):\n    return read_rows(path)",
      executionOutput: "[]",
    });
  } finally {
    rmSync(runRoot(runId), { recursive: true, force: true });
  }
}

const twoSatisfiedChecks = JSON.stringify([
  { index: 0, check: "The callable interface is retained", status: "satisfied", issue: "The callable name and parameter are retained.", sourceEvidence: "def summarize(path):", implementationEvidence: "def summarize(path):" },
  { index: 1, check: "The input rows are returned", status: "satisfied", issue: "The function returns the rows read from the supplied path.", sourceEvidence: "return read_rows(path)", implementationEvidence: "return read_rows(path)" },
]);

describe("code review evidence contract", () => {
  it('does not accept import line references as proof of repaired behavior',async()=>{
    const runId=randomUUID();
    const gateway=reviewGateway(JSON.stringify([{index:0,status:'satisfied',issue:'The boundary is inclusive.',sourceLineNumbers:[1],codeLineNumbers:[1]}]));
    try{
      await expect(withRuntimeScope({runId,mode:'work',signal:new AbortController().signal,remainingRecoveryAttempts:0},()=>reviewAttachedPython({runId,gateway,modelId:'primary-model',request:'Include equality at the boundary.',sourceEvidence:'import csv\nif value > limit:',currentSource:'import csv\nif value >= limit:',sourceChecklist:JSON.stringify({checks:['Include equality at the boundary.']}),executionOutput:''}))).rejects.toThrow('1 checks remain');
    }finally{rmSync(runRoot(runId),{recursive:true,force:true});}
  });
  it.each([0,999,1.5])('rejects an invalid line reference without accepting its criterion: %s',async invalid=>{
    const runId=randomUUID();
    const accepted:any[]=[];
    const gateway=reviewGateway(JSON.stringify([
      {index:0,status:'satisfied',issue:'The interface is preserved.',sourceLineNumbers:[2],codeLineNumbers:[1]},
      {index:1,status:'satisfied',issue:'The return is preserved.',sourceLineNumbers:[3],codeLineNumbers:[invalid]},
    ]));
    try{
      await expect(withRuntimeScope({runId,mode:'work',signal:new AbortController().signal,remainingRecoveryAttempts:0},()=>reviewAttachedPython({runId,gateway,modelId:'primary-model',request:'Keep interface and return.',sourceEvidence:'def summarize(path):\n    return []',currentSource:'def summarize(path):\n    return []',sourceChecklist:JSON.stringify({checks:['Keep the interface.','Keep the return.']}),executionOutput:'[]',onAccepted:items=>accepted.push(...items)}))).rejects.toThrow('1 checks remain');
      expect(accepted).toHaveLength(1);expect(accepted[0].check).toBe('Keep the interface.');
    }finally{rmSync(runRoot(runId),{recursive:true,force:true});}
  });
  it('resolves line references to separate exact evidence spans',async()=>{
    const runId=randomUUID();
    const gateway=reviewGateway(JSON.stringify([{index:0,status:'satisfied',issue:'The function returns the expected type.',sourceLineNumbers:[2,3],codeLineNumbers:[1,2]}]));
    const accepted:any[]=[];
    try{
      await expect(withRuntimeScope({runId,mode:'work',signal:new AbortController().signal,remainingRecoveryAttempts:0},()=>reviewAttachedPython({runId,gateway,modelId:'primary-model',request:'Keep interface and return.',sourceEvidence:'def summarize(path):\n    return []',currentSource:'def summarize(path):\n    return []',sourceChecklist:JSON.stringify({checks:['Keep the interface and return.']}),executionOutput:'[]',onAccepted:items=>accepted.push(...items)}))).resolves.toEqual([]);
      expect(accepted[0].sourceEvidence).toEqual(['def summarize(path):','    return []']);
      expect(accepted[0].implementationEvidence).toEqual(['def summarize(path):','    return []']);
    }finally{rmSync(runRoot(runId),{recursive:true,force:true});}
  });
  it.each([false,true])('checks every separate quote in a compound behavior assessment (invented quote: %s)',async invented=>{
    const runId=randomUUID();
    const source='def summarize(path):\n    if temperature > 350.0:\n        high += 1\n    return high';
    const current=source.replace('> 350.0','>= 350.0');
    const gateway=reviewGateway(JSON.stringify([{index:0,status:'satisfied',issue:'The callable and return remain; equality now counts.',sourceEvidence:['def summarize(path):','Include equality at 350.0.'],implementationEvidence:['def summarize(path):','if temperature >= 350.0:',invented?'return invented':'return high'],executionEvidence:['"exitCode":0']}]));
    try{
      const result=withRuntimeScope({runId,mode:'work',signal:new AbortController().signal,remainingRecoveryAttempts:0},()=>reviewAttachedPython({runId,gateway,modelId:'primary-model',request:'Include equality at 350.0.',sourceEvidence:source,currentSource:current,sourceChecklist:JSON.stringify({checks:['Keep the callable and return contract; include equality at the boundary.']}),executionOutput:'2',executionEvidence:'{"exitCode":0}'}));
      if(invented)await expect(result).rejects.toThrow('did not provide source and code evidence');
      else await expect(result).resolves.toEqual([]);
    }finally{rmSync(runRoot(runId),{recursive:true,force:true});}
  });
  it("reviews every behavior check in bounded batches above the former eight-check cap", async () => {
    const runId=randomUUID();
    const checks=Array.from({length:19},(_,index)=>`Preserve behavior ${index}.`);
    const batches:string[][]=[];
    const gateway={chatWithTools:vi.fn(async(_model,messages,_tools,options)=>{
      const input=JSON.parse(messages[1].content);batches.push(input.behaviorChecks.map((item:any)=>item.check));
      expect(input.behaviorChecks.length).toBeLessThanOrEqual(8);
      expect(options.maxTokens).toBe(Math.max(1536,512+384*input.behaviorChecks.length));
      return {ok:true,value:{finishReason:'stop',content:JSON.stringify(input.behaviorChecks.map((item:any)=>({index:item.index,status:'satisfied',issue:'The callable remains.',sourceEvidence:'def summarize(path):',implementationEvidence:'def summarize(path):'})))}};
    })};
    try{
      const accepted:any[]=[];
      await expect(withRuntimeScope({runId,mode:'work',signal:new AbortController().signal,remainingRecoveryAttempts:2},()=>reviewAttachedPython({gateway:gateway as any,modelId:'primary-model',runId,request:'Preserve every behavior.',sourceEvidence:'def summarize(path):',sourceChecklist:JSON.stringify({checks}),currentSource:'def summarize(path):\n    return []',executionOutput:'[]',onAccepted:items=>{accepted.splice(0,accepted.length,...items);}}))).resolves.toEqual([]);
      expect(batches.flat()).toEqual(checks);expect(accepted).toHaveLength(19);expect(gateway.chatWithTools).toHaveBeenCalledTimes(3);
      await withRuntimeScope({runId,mode:'work',signal:new AbortController().signal,remainingRecoveryAttempts:0},()=>reviewAttachedPython({gateway:gateway as any,modelId:'primary-model',runId,request:'Preserve every behavior.',sourceEvidence:'def summarize(path):',sourceChecklist:JSON.stringify({checks}),currentSource:'def summarize(path):\n    return []',executionOutput:'[]',acceptedChecks:accepted}));
      expect(gateway.chatWithTools).toHaveBeenCalledTimes(3);
    }finally{rmSync(runRoot(runId),{recursive:true,force:true});}
  });
  it("rejects duplicate behavior indexes instead of treating repeated entries as coverage",async()=>{
    const runId=randomUUID();
    const duplicate=JSON.parse(twoSatisfiedChecks);duplicate[1].index=0;
    try{
      await expect(withRuntimeScope({runId,mode:'work',signal:new AbortController().signal,remainingRecoveryAttempts:0},()=>reviewAttachedPython({gateway:reviewGateway(JSON.stringify(duplicate)),modelId:'primary-model',runId,request:'Repair the source.',sourceEvidence:'def summarize(path):\n    return read_rows(path)',sourceChecklist:JSON.stringify({checks:['Preserve the callable interface.','Return the rows read from the input.']}),currentSource:'def summarize(path):\n    return read_rows(path)',executionOutput:'[]'}))).rejects.toThrow('did not provide source and code evidence');
    }finally{rmSync(runRoot(runId),{recursive:true,force:true});}
  });
  it.each([true, false, null])("retries unsupported Work review evidence within its budget: %s", async repaired => {
    const runId = randomUUID();
    const valid = JSON.parse(twoSatisfiedChecks);
    const unsupported = { ...valid[1], sourceEvidence: "invented source quote" };
    const gateway = { chatWithTools: vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { content: JSON.stringify([valid[0], unsupported]), finishReason: "stop" } })
      .mockResolvedValueOnce({ ok: true, value: { content: JSON.stringify([{ ...(repaired ? valid[1] : unsupported), index: 0 }]), finishReason: "stop" } }) };
    const source = "def summarize(path):\n    return read_rows(path)";
    try {
      const operation = withRuntimeScope({ runId, mode: "work", signal: new AbortController().signal,
        remainingRecoveryAttempts: repaired === null ? 0 : 1,
      }, () => reviewAttachedPython({ gateway: gateway as any, modelId: "primary-model" as ModelId, runId,
        request: "Repair the source.", sourceEvidence: source,
        sourceChecklist: JSON.stringify({ checks: ["Preserve the callable interface.", "Return the rows read from the input."] }),
        currentSource: source, executionOutput: "[]",
      }));
      if (repaired) await expect(operation).resolves.toEqual([]);
      else await expect(operation).rejects.toThrow("did not provide source and code evidence");
      expect(gateway.chatWithTools).toHaveBeenCalledTimes(repaired === null ? 1 : 2);
      if (repaired !== null) {
        const retry = JSON.parse(gateway.chatWithTools.mock.calls[1][1][1].content);
        expect(retry.behaviorChecks).toEqual([{ index: 0, check: "Return the rows read from the input." }]);
        expect(retry.codeLines.map((item:any)=>item.text).join('\n')).toBe(source);
        expect(retry.reviewFeedback).toContain("exact contiguous quote");
      }
    } finally { rmSync(runRoot(runId), { recursive: true, force: true }); }
  });

  it("requires a review entry for each indexed behavior check", async () => {
    const runId = randomUUID();
    const checks = ["Preserve the callable interface.", "Return the rows read from the input."];
    const gateway = { chatWithTools: vi.fn(async (_model, messages, _tools, options) => {
      const input = JSON.parse(messages[1].content);
      expect(input.behaviorChecks).toEqual(checks.map((check, index) => ({ index, check })));
      expect(options.responseSchema.schema).toMatchObject({ minItems: 2, maxItems: 2 });
      return { ok: true, value: { content: twoSatisfiedChecks, finishReason: "stop" } };
    }) };
    try {
      await expect(reviewAttachedPython({ gateway: gateway as any, modelId: "primary-model" as ModelId, runId,
        request: "Repair the source.", sourceEvidence: "def summarize(path):\n    return read_rows(path)",
        sourceChecklist: JSON.stringify({ checks }), currentSource: "def summarize(path):\n    return read_rows(path)",
        executionOutput: "[]",
      })).resolves.toEqual([]);
      expect(gateway.chatWithTools).toHaveBeenCalledTimes(1);
    } finally { rmSync(runRoot(runId), { recursive: true, force: true }); }
  });

  it('detects an unconditional update moved into a new else branch',()=>{
    const source='for item in items:\n    if item.failed:\n        errors += 1\n    processed += 1\n';
    expect(unmarkedConditionalUpdateGaps(source,'for item in items:\n    if item.failed:\n        errors += 1\n    else:\n        processed += 1\n')).toEqual([expect.objectContaining({evidence:'processed += 1'})]);
    expect(unmarkedConditionalUpdateGaps(source,source)).toEqual([]);
    expect(unmarkedConditionalUpdateGaps('# BUG: count the wrong cases\nprocessed += 1\n','if valid:\n    processed += 1\n')).toEqual([]);
  });
  it('allows a faulty branch body to change with its predicate retained',()=>{
    expect(unchangedMarkedConditionGaps('# BUG: increments the wrong field\nif item.failed:\n    processed += 1\n','if item.failed:\n    errors += 1\n')).toEqual([]);
  });
  it('rejects an unchanged source-marked predicate even when the candidate removes its comment',()=>{
    const original='# BUG: This boundary must include equality.\nif reading > limit:\n    record(reading)\n';
    const gaps=unchangedMarkedConditionGaps(original,'if reading > limit:\n    record(reading)\n');
    expect(gaps).toHaveLength(1);expect(gaps[0].evidence).toContain('include equality');
    expect(unchangedMarkedConditionGaps(original,'if reading >= limit:\n    record(reading)\n')).toEqual([]);
    const numeric='# BUG: The inclusive upper boundary is 42.0.\nif reading > 42.0:\n    record(reading)\n';
    expect(unchangedMarkedConditionGaps(numeric,'if reading > 41.5:\n    record(reading)\n')).toEqual([expect.objectContaining({issue:expect.stringContaining('without request evidence')})]);
    expect(unchangedMarkedConditionGaps(numeric,'if reading >= 42.0:\n    record(reading)\n')).toEqual([]);
    expect(unchangedMarkedConditionGaps(numeric,"if reading == '42.0':\n    record(reading)\n")).toEqual([expect.objectContaining({issue:expect.stringContaining('equality-only')})]);
    expect(unchangedMarkedConditionGaps(numeric,'if reading >= 40.0:\n    record(reading)\n','Use an inclusive upper limit of 40.0.')).toEqual([]);
  });
  it('allows a retained conversion when a source-marked crash is fixed by a guard',()=>{
    const original='# BUG: Empty readings cause a conversion crash.\nreading = float(value)\n';
    expect(unchangedMarkedConditionGaps(original,'if not value:\n    return None\nreading = float(value)\n')).toEqual([]);
  });
  it("rejects a bare satisfied label without an explanation", async () => {
    const checks = JSON.parse(twoSatisfiedChecks);
    checks[0].issue = "";
    await expect(reviewAttachedCode(JSON.stringify(checks))).rejects.toThrow("did not assess every source-derived check");
  });
});

describe("grounded findings table alignment", () => {
  it("flags an assessment placed in the requirement column", () => {
    const candidate = [
      "| Identifier | Observation | Requirement | Assessment | Action | Evidence |",
      "|---|---|---|---|---|---|",
      "| Item A | Observed value | Compliant | None | None | Source §2 |",
    ].join("\n");

    expect(findingsTableAlignmentGaps(candidate)).toEqual([
      "Findings row for Item A: a status is in Requirement. Put the applicable source criterion in Requirement and the status in Assessment.",
    ]);
  });

  it("accepts a row with a criterion and an assessment in their matching columns", () => {
    const candidate = [
      "| Identifier | Observation | Requirement | Assessment | Action | Evidence |",
      "|---|---|---|---|---|---|",
      "| Item A | Observed value | Applicable minimum | Non-compliant | Correct the item | Source §2 |",
    ].join("\n");

    expect(findingsTableAlignmentGaps(candidate)).toEqual([]);
  });

  it("keeps a recommendation linked to its existing subject heading", () => {
    const candidate = [
      "## Report ID: REF-2026-01",
      "### Equipment: Unit Alpha",
      "**Action Required:**",
      "- Retest after repair. [Standard §2]",
    ].join("\n");

    expect(linkRecommendationsToSubjects(candidate)).toContain("- Retest after repair. [Standard §2]");
    expect(linkRecommendationsToSubjects(candidate)).toContain("**Action Required:**");
  });

  it("links inline recommendation text to the subject heading", () => {
    const candidate = [
      "## Report ID: REF-2026-01",
      "### Equipment: Unit Alpha",
      "**Recommendation:** Conditional release after the supported repair. [Standard §2]",
      "**Grounding References:**",
      "- Standard §2",
    ].join("\n");

    const linked = linkRecommendationsToSubjects(candidate);
    expect(linked).toContain("Recommendation for Unit Alpha: Conditional release after the supported repair. [Standard §2]");
    expect(linked).not.toContain("For Unit Alpha: **Grounding References:**");
  });

  it("links a separate approval decision to the subject heading", () => {
    const candidate = "## Report ID: REF-1\n### Asset: Unit Alpha\n**Approval decision:** Pending the required evidence.";
    expect(linkRecommendationsToSubjects(candidate)).toContain("Approval decision for Unit Alpha: Pending the required evidence.");
  });

  it("preserves previously covered subject sections when a correction omits them", () => {
    const previous = "## Report ID: R-1\n### Equipment: Unit Alpha\nFinding: inspect seal";
    const corrected = "# Report\n\n## Report ID: R-2\n### Equipment: Unit Beta\nFinding: replace gasket\n\n## Source documents\n- report.pdf";
    const merged = preserveMissingSubjectSections(previous, corrected);
    expect(merged.indexOf("Unit Alpha")).toBeGreaterThanOrEqual(0);
    expect(merged.indexOf("Unit Beta")).toBeGreaterThanOrEqual(0);
    expect(merged.indexOf("Unit Beta")).toBeLessThan(merged.indexOf("Source documents"));
    expect(merged.indexOf("Unit Alpha")).toBeLessThan(merged.indexOf("Source documents"));
  });

  it("does not duplicate a subject already covered by a corrected section", () => {
    const previous = "## Report ID: R-1\n### Equipment: Unit Alpha\nFinding: retain this";
    const corrected = "## Report ID: R-1\n### Equipment: Unit Alpha\nFinding: corrected";
    expect(preserveMissingSubjectSections(previous, corrected).match(/Finding:/g)).toHaveLength(1);
  });

  it("preserves exact extracted annotations under the matching subject", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf (application/pdf, 2 pages) ---",
      "Report ID: R-1\nEquipment: Unit Alpha",
      'Source annotations preceding reviewer/inspector attribution (verbatim evidence): [{"page":2,"text":"Inspect the joint again."}]',
      "--- END ATTACHED FILE: report.pdf ---",
    ].join("\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\nFindings complete.\n\n## Source documents\n- report.pdf";
    const preserved = preserveExtractedAnnotations(evidence, candidate);
    expect(preserved).toContain("**Source annotation for R-1:** Inspect the joint again. (report.pdf, p. 2)");
  });

  it("restores annotation records supplied as structured extraction data", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf ---\nReport ID: R-1\nEquipment: Unit Alpha\n--- END ATTACHED FILE: report.pdf ---",
      'EXTRACTED SOURCE ANNOTATIONS JSON:\n[{"text":"Check the repaired item.","sourceFile":"report.pdf","page":2}]',
    ].join("\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\nFindings.\n\n## Source documents\n- report.pdf";
    expect(preserveExtractedAnnotations(evidence, candidate)).toContain("Check the repaired item.");
  });

  it("restores omitted structured findings with their source and subject", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf (application/pdf, 2 pages) ---",
      "Report ID: R-1\nEquipment: Unit Alpha",
      "--- END ATTACHED FILE: report.pdf ---",
      'EXTRACTED DOCUMENT FINDINGS JSON:\n[{"title":"Surface condition","value":"Localized wear was observed.","evidence":"page record","sourceFile":"report.pdf","page":2}]',
      "EXTRACTED SOURCE ANNOTATIONS JSON:\n[]",
    ].join("\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\nInitial finding.\n\n## Source documents\n- report.pdf";
    const preserved = preserveExtractedFindings(evidence, candidate);
    expect(preserved).toContain("**Surface condition:** Localized wear was observed.");
    expect(preserved).toContain("report.pdf, p. 2");
  });

  it("keeps a conditional decision pending when its retrieved prerequisite is not in the source", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf ---\nReport ID: R-1\nEquipment: Unit Alpha\nObserved condition recorded.\n--- END ATTACHED FILE: report.pdf ---",
      "RETRIEVED CRITERIA:\nConditional release may be recorded only when the sample set is approved.",
    ].join("\n\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\n**Approval decision:** Conditional release.\n\n## Source documents\n- report.pdf";
    expect(enforceSourceConditionalPreconditions("Draft an approval note.", evidence, candidate))
      .toContain("Approval decision for Unit Alpha: Pending until the source shows that the sample set is approved.");
  });

  it("does not add a pending status when the subject source shows the prerequisite", () => {
    const evidence = [
      "--- ATTACHED FILE: report.pdf ---\nReport ID: R-1\nEquipment: Unit Alpha\nThe sample set is approved.\n--- END ATTACHED FILE: report.pdf ---",
      "RETRIEVED CRITERIA:\nConditional release may be recorded only when the sample set is approved.",
    ].join("\n\n");
    const candidate = "## Report ID: R-1\n### Equipment: Unit Alpha\n**Approval decision:** Conditional release.\n\n## Source documents\n- report.pdf";
    expect(enforceSourceConditionalPreconditions("Draft an approval note.", evidence, candidate))
      .not.toContain("Pending until the source shows");
  });
});

describe("attached code behavior review", () => {
  it("binds same-count review results to the ordered checks when labels are paraphrased", async () => {
    await expect(reviewAttachedCode(twoSatisfiedChecks)).resolves.toEqual([]);
  });

  it("does not let an ungrounded reviewer claim steer a repair", async () => {
    const ungroundedGap = JSON.stringify([
      { index: 0, check: "Preserve the callable interface.", status: "gap", issue: "Change the interface.", sourceEvidence: "unsupported source quote", implementationEvidence: "missing implementation quote" },
      { index: 1, check: "Return the rows read from the input.", status: "satisfied", issue: "The function returns the rows read from the supplied path.", sourceEvidence: "return read_rows(path)", implementationEvidence: "return read_rows(path)" },
    ]);
    await expect(reviewAttachedCode(ungroundedGap)).resolves.toEqual([]);
  });

  it("returns only pre-execution gaps grounded in both source and proposed code", async () => {
    const gateway = reviewGateway(JSON.stringify({ gaps: [{
      check: "Preserve input conversion behavior.", issue: "Empty input reaches conversion.",
      sourceEvidence: "An empty value is supported by the input contract.",
      implementationEvidence: "float(row.get('value', 0))",
    }] }));
    const findings = await reviewProposedPython({
      gateway, modelId: "primary-model" as ModelId, runId: randomUUID(),
      request: "Repair the attached parser.", sourceEvidence: "An empty value is supported by the input contract.",
      sourceChecklist: JSON.stringify({ checks: ["Handle empty values supported by input."] }),
      proposedSource: "temperature = float(row.get('value', 0))",
    });
    expect(findings).toEqual([{ issue: "Empty input reaches conversion. (check: Preserve input conversion behavior.)", evidence: "An empty value is supported by the input contract." }]);
  });

  it("catches a missing return for a source-declared function contract before execution", async () => {
    const findings = await reviewProposedPython({
      gateway: reviewGateway(JSON.stringify({ gaps: [] })), modelId: "primary-model" as ModelId, runId: randomUUID(),
      request: "Repair the attached source.",
      sourceEvidence: "--- ATTACHED FILE: source.py ---\ndef summarize(path: str) -> dict[str, int]:\n    return {}\n--- END ATTACHED FILE: source.py ---",
      sourceChecklist: JSON.stringify({ checks: ["Preserve the callable return contract."] }),
      proposedSource: "def summarize(path: str) -> dict[str, int]:\n    counts = {}\n",
    });
    expect(findings).toEqual([{
      issue: "Function summarize has no explicit return, but its source declares a non-None return type.",
      evidence: "def summarize(path: str) -> dict[str, int]:",
    }]);
  });

  it("accepts a grounded model finding about an excluded boundary", async () => {
    const runId = randomUUID();
    try {
      const findings = await reviewAttachedPython({
        gateway: reviewGateway(JSON.stringify([{
          index: 0, status: "gap", issue: "The comparison excludes equality.", sourceEvidence: "The inclusive 42.0 upper limit is documented.",
          implementationEvidence: "if reading > 42.0:",
        }])), modelId: "primary-model" as ModelId, runId,
        request: "Repair the attached parser.",
        sourceEvidence: "The inclusive 42.0 upper limit is documented.\nif reading > 42.0:",
        sourceChecklist: JSON.stringify({ checks: ["Ensure readings greater than or equal to 42.0 are included."] }),
        currentSource: "if reading > 42.0:\n    count += 1",
        executionOutput: "count=1",
      });
      expect(findings).toEqual([{
        issue: "The comparison excludes equality. (check: Ensure readings greater than or equal to 42.0 are included.)",
        evidence: "The inclusive 42.0 upper limit is documented.",
      }]);
    } finally {
      rmSync(runRoot(runId), { recursive: true, force: true });
    }
  });
});
