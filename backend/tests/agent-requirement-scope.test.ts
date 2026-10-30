import { expect, it, vi } from "vitest";
import { Validator } from "jsonschema";
import type { AgentTask } from "../src/shared/contracts.js";
import { agentInterpretationFormat, agentScopeSources, agentSourceRequirementFormat, parseAgentSourceRequirements, parseTaskInterpretation } from "../src/main/agent/task-interpretation.js";

import { reviewAgentInterpretation } from "../src/main/agent/requirement-scope.js";
import type { ToolExecutionContext } from "../src/main/tools/types.js";

const messageId="11111111-1111-4111-8111-111111111111",priorId="22222222-2222-4222-8222-222222222222",taskId="33333333-3333-4333-8333-333333333333";
function task(text:string,prior?:string):AgentTask {
  return {taskId,chatId:"44444444-4444-4444-8444-444444444444",workspace:{root:"/project",registeredAt:"first"},status:"open",current:true,
    snapshot:{schemaVersion:1,taskId,revision:1,messages:[...(prior ? [{id:priorId,content:prior,disposition:"pending" as const}] : []),{id:messageId,content:text,disposition:"pending"}],requirements:[]}};
}
const proposal=(kind:string,description:string)=>({kind,description,check:{operation:"semantic",path:null}});

it("partitions current and pending sources without losing bytes or mixing their identities",()=>{
  const current="Continue.\nExplain the result.",prior="Inspect the module. Repair its two defects; run tests.\n";
  const units=agentScopeSources(task(current,prior),messageId);
  expect(units.filter(unit=>unit.messageId === priorId).map(unit=>unit.text).join("")).toBe(prior);
  expect(units.filter(unit=>unit.messageId === messageId).map(unit=>unit.text).join("")).toBe(current);
  expect(units.filter(unit=>unit.messageId === priorId).every(unit=>unit.sourceId.startsWith("p1:"))).toBe(true);
  expect(new Set(units.map(unit=>unit.sourceId)).size).toBe(units.length);
});

it("builds distinct mechanical checks from compact mixed obligations at one exact saved source",()=>{
  const text="Run the full tests and explain the fix.",saved=task(text),unit=agentScopeSources(saved,messageId)[0];
  const parsed=parseAgentSourceRequirements(JSON.stringify({requirements:[proposal("execute","Run all existing tests"),proposal("deliver","Explain each fix")],full_suite:true}),unit,messageId,text,"continue",saved);
  expect(parsed.fullSuite).toBe(true);
  const requirements=parsed.updates.flatMap(update=>update.operation === "append" ? [update.requirement] : []);
  expect(requirements.map(item=>item.kind)).toEqual(["execute","deliver"]);
  expect(requirements.map(item=>item.acceptance[0].kind)).toEqual(["execution","delivery"]);
  expect(requirements.every(item=>item.source.quote === text && item.source.messageId === messageId)).toBe(true);
  expect(new Set(requirements.map(item=>item.id)).size).toBe(2);
});

it("rejects extra scope updates, fabricated source units, and literal checks without a quoted basis",()=>{
  const text="Repair the parser.",saved=task(text),unit=agentScopeSources(saved,messageId)[0];
  const input={requirements:[proposal("change","Repair the parser")],full_suite:false};
  const parse=(value:unknown,source=unit)=>parseAgentSourceRequirements(JSON.stringify(value),source,messageId,text,"continue",saved);
  expect(()=>parse({...input,updates:[{operation:"waive",requirementId:"old"}]})).toThrow();
  expect(()=>parse(input,{...unit,text:"Delete the parser."})).toThrow("saved user message");
  expect(()=>parse({requirements:[{kind:"inspect",description:"Copy parser",check:{operation:"verbatim_source",path:"parser.ts"}}],full_suite:false})).toThrow("direct request");
  expect(()=>parse({requirements:[{kind:"execute",description:"Run parser",check:{operation:"verbatim_source",path:"parser.ts"}}],full_suite:false})).toThrow("inspection or delivery");
});

it("uses the earlier pending source for a literal request on continuation",()=>{
  const prior="Read the exact content of parser.ts.",current="Continue",saved=task(current,prior),unit=agentScopeSources(saved,messageId)[0];
  const input={requirements:[{kind:"inspect",description:"Copy parser.ts",check:{operation:"verbatim_source",path:"parser.ts"}}],full_suite:false};
  const parsed=parseAgentSourceRequirements(JSON.stringify(input),unit,messageId,current,"continue",saved);
  expect(parsed.updates[0]).toMatchObject({operation:"append",requirement:{source:{messageId:priorId,quote:prior},acceptance:[{kind:"inspection",operation:"verbatim_source",path:"parser.ts"}]}});
  const validator=new Validator();
  expect(validator.validate(input,agentSourceRequirementFormat(prior).schema).valid).toBe(true);
  expect(validator.validate(input,agentSourceRequirementFormat("Repair parser.ts.").schema).valid).toBe(false);
  expect(JSON.stringify(agentSourceRequirementFormat(prior).schema)).not.toContain('"not":');
  expect(validator.validate({...input,source_id:"p2:s1"},agentSourceRequirementFormat(prior).schema).valid).toBe(false);
  const broad={disposition:"continue",requirements:[{kind:"inspect",description:"Read parser.ts",source_id:"p1:s1",checks:[{description:"Copy parser.ts",kind:"inspection",operation:"verbatim_source",path:"parser.ts"}]}],updates:[],full_suite:false};
  expect(validator.validate(broad,agentInterpretationFormat(current,saved,messageId).schema).valid).toBe(true);
});

function scopeCandidate() {
  const text="Reproduce failing tests and repair filtering and invalid storage";
  const saved=task(text);
  const candidate=parseTaskInterpretation(JSON.stringify({disposition:"continue",requirements:[{kind:"execute",description:text,source_id:"request",checks:["Reproduce failing tests","Repair filtering","Repair invalid storage"].map(description=>({description,kind:"execution",operation:"semantic",path:null}))}],updates:[],full_suite:false}),messageId,text,saved);
  return {saved,candidate};
}
it("binds separate coverage obligations to real acceptance refs instead of a free pass Boolean",async()=>{
  const {saved,candidate}=scopeCandidate(),registerResult=vi.fn();
  const gateway={chatWithTools:vi.fn(async(_model,messages,_tools,options)=>{
    const input=JSON.parse(messages[1].content),checks=input.requirements[0].checks;
    const output={obligations:checks.map((check:{description:string;ref:string})=>({description:check.description,check_refs:[check.ref]})),full_suite:true};
    expect(new Validator().validate(output,options.responseSchema.schema).valid).toBe(true);
    return {ok:true,value:{content:JSON.stringify(output)}};
  })};
  const reviewed=await reviewAgentInterpretation(saved,candidate,{gateway,resultStore:{registerResult}} as unknown as ToolExecutionContext,"driver",messageId);
  expect(reviewed).toMatchObject({covered:true,gaps:[],fullSuite:true});
  const payload=registerResult.mock.calls[0][0].payload;
  expect(payload.mapping.obligations).toHaveLength(3);
  expect(payload.mapping.obligations.every((item:{check_refs:string[]})=>item.check_refs.length === 1)).toBe(true);
});
it.each(["unknown","empty","boolean"])("rejects %s coverage instead of authorizing a task",async kind=>{
  const {saved,candidate}=scopeCandidate();
  const output=kind === "unknown" ? {obligations:[{description:"Repair filtering",check_refs:["invented/check"]}],full_suite:false} : kind === "empty" ? {obligations:[],full_suite:false} : {covered:true,missing:[],full_suite:false};
  const context={gateway:{chatWithTools:async()=>({ok:true,value:{content:JSON.stringify(output)}})},resultStore:{registerResult:vi.fn()}} as unknown as ToolExecutionContext;
  await expect(reviewAgentInterpretation(saved,candidate,context,"driver",messageId)).rejects.toThrow();
  expect(context.resultStore!.registerResult).not.toHaveBeenCalled();
});
it("retains an unmapped obligation as a source-bound gap for bounded extraction",async()=>{
  const {saved,candidate}=scopeCandidate();
  const context={gateway:{chatWithTools:async()=>({ok:true,value:{content:JSON.stringify({obligations:[{description:"Repair saved-data shape checks",check_refs:[]}],full_suite:false})}})},resultStore:{registerResult:vi.fn()}} as unknown as ToolExecutionContext;
  const review=await reviewAgentInterpretation(saved,candidate,context,"driver",messageId);
  expect(review.covered).toBe(false);expect(review.gaps).toEqual([{source:agentScopeSources(saved,messageId)[0],detail:"Repair saved-data shape checks"}]);
});
