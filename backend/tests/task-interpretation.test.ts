import { describe, expect, it } from "vitest";
import { agentMessageSources, interpretationMessages, parseTaskInterpretation } from "../src/main/agent/task-interpretation.js";
import type { AgentTask } from "../src/shared/contracts.js";

const messageId = "00000000-0000-4000-8000-000000000001";
const requirement = (source_id: string, kind = "change") => ({kind,description:"Repair the requested behavior",source_id,checks:[{description:"Check the repair",kind:"review",operation:"semantic",path:null}]});
const response = (requirements: unknown[], updates: unknown[] = [], disposition = "continue") => JSON.stringify({disposition,requirements,updates,full_suite:false});

describe("Host-owned requirement source spans", () => {
  it("preserves every source character across Unicode, line endings, code, and repeated sentences", () => {
    const text = '\ufeffInspect café.js.\r\nRepair it; preserve UI. Repair it.\n```js\nconst value = "🛠️";\n```\n  ';
    const spans = agentMessageSources(text);
    expect(spans.map(item=>item.text).join("")).toBe(text);
    for (const [index,span] of spans.entries()) {
      expect(span.start).toBe(index ? spans[index-1].end : 0);
      expect(text.slice(span.start,span.end)).toBe(span.text);
    }
    const input = JSON.parse(interpretationMessages(text)[1].content);
    expect(input.sources.map((item: any)=>item.text).join("")).toBe(text);
  });
  it("constructs an exact quotation for the selected occurrence of repeated text", () => {
    const text = "Repair it. Repair it.";
    const parsed = parseTaskInterpretation(response([requirement("s2")]),messageId,text);
    expect(parsed.updates[0]).toMatchObject({operation:"append",requirement:{source:{messageId,start:10,end:text.length,quote:" Repair it."}}});
  });
  it("allows separate repairs to cite the same span with distinct stable IDs", () => {
    const text = "Repair both defects.";
    const wire = response([requirement("s1"),{...requirement("s1"),description:"Repair the second defect"}]);
    const first = parseTaskInterpretation(wire,messageId,text), repeated = parseTaskInterpretation(wire,messageId,text);
    expect(first).toEqual(repeated);
    const ids = first.updates.map(item=>item.operation === "append" ? item.requirement.id : "");
    expect(new Set(ids).size).toBe(2);
  });
  it("rejects unknown references and model-written quotations or offsets", () => {
    const text = "Repair it.";
    expect(()=>parseTaskInterpretation(response([requirement("s99")]),messageId,text)).toThrow("source reference is unknown");
    for (const extra of [{quote:"Repair It."},{start:0,end:10}]) {
      expect(()=>parseTaskInterpretation(response([{...requirement("s1"),...extra}]),messageId,text)).toThrow();
    }
  });
  it("constructs a spanning quotation from the complete request without normalizing its text", () => {
    const text = "Inspect.\r\nRepair 🛠️.\r\n";
    expect(parseTaskInterpretation(response([requirement("request")]),messageId,text).updates[0]).toMatchObject({requirement:{source:{start:0,end:text.length,quote:text}}});
    expect(()=>parseTaskInterpretation(response([requirement("request")]),messageId," \r\n")).toThrow("source reference is unknown or blank");
  });
  it("constructs waiver provenance from the current request and retains disposition checks", () => {
    const text = "Keep the repair. Skip tests.";
    const updates = [{operation:"waive",requirementId:"tests",source_id:"s2"}];
    expect(parseTaskInterpretation(response([],updates,"scope_revision"),messageId,text).updates[0]).toMatchObject({operation:"waive",source:{messageId,quote:" Skip tests."}});
    expect(()=>parseTaskInterpretation(response([],updates),messageId,text)).toThrow("direct scope revision");
  });
  it("resolves earlier pending source references while refusing them as waiver authority", () => {
    const priorId = "00000000-0000-4000-8000-000000000002";
    const task:AgentTask = {taskId:priorId,chatId:priorId,workspace:{root:"/project",registeredAt:"first"},status:"open",current:true,
      snapshot:{schemaVersion:1,taskId:priorId,revision:1,messages:[{id:priorId,content:"Repair startup. Keep UI.",disposition:"pending"}],requirements:[]}};
    const input = JSON.parse(interpretationMessages("Continue",task,messageId)[1].content);
    expect(input.pendingRequests[0].sources.map((item:any)=>item.text).join("")).toBe("Repair startup. Keep UI.");
    expect(parseTaskInterpretation(response([requirement("p1:s2","preserve")]),messageId,"Continue",task).updates[0]).toMatchObject({requirement:{source:{messageId:priorId,quote:" Keep UI."}}});
    expect(()=>parseTaskInterpretation(response([],[{operation:"waive",requirementId:"tests",source_id:"p1:request"}],"scope_revision"),messageId,"Continue",task)).toThrow("current user message");
    task.snapshot.messages[0].disposition="continue";
    expect(()=>parseTaskInterpretation(response([requirement("p1:request")]),messageId,"Continue",task)).toThrow("pending source reference is unknown");
  });
});
