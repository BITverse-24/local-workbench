import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Validator } from "jsonschema";
import { bindAgentRepairProposal, REPAIR_PROPOSAL_TOOL } from "../src/main/agent/repair-proposal.js";
import { agentJSONResponseFormat } from "../src/main/gateway/model-gateway.js";

const source={path:"src/storage.js",digest:"a".repeat(64),focusKey:"b".repeat(64),expanded:false};
const proposal=(arguments_:Record<string,unknown>)=>({id:randomUUID(),name:"propose_repair",arguments:arguments_});

describe("Host-bound repair proposals",()=>{
  it("binds inspected source identity and preserves raw lines in native and JSON envelopes",()=>{
    const args={kind:"edit",requirement_id:"repair-storage",replacements:[{old:[String.raw`  return text.replace(/\n/g, "\\n");`],new:["  // café 🛠️",String.raw`  return text.replace(/\n/g, "\\n");`,""]}]};
    const native=proposal(args),schema=new Validator();
    expect(schema.validate(args,JSON.parse(JSON.stringify(REPAIR_PROPOSAL_TOOL.function.parameters))).valid).toBe(true);
    const envelope={tool_calls:[{name:"propose_repair",arguments:args}],content:""};
    expect(schema.validate(envelope,agentJSONResponseFormat([REPAIR_PROPOSAL_TOOL],true).json_schema.schema).valid).toBe(true);
    const fromJSON=proposal(JSON.parse(JSON.stringify(envelope)).tool_calls[0].arguments);
    const left=bindAgentRepairProposal(native,source),right=bindAgentRepairProposal(fromJSON,source);
    expect(left).toEqual({...right,call:{...(right as any).call,id:native.id}});
    expect(left).toMatchObject({call:{name:"edit_file",arguments:{path:source.path,expected_digest:source.digest,requirement_id:"repair-storage",replacements:[{old:args.replacements[0].old.join("\n"),new:args.replacements[0].new.join("\n")}]}}});
  });
  it("does not accept a model-supplied target, digest, command, or Markdown edit",()=>{
    const valid={kind:"edit",replacements:[{old:["old"],new:["new"]}]};
    for(const extra of [{path:"../outside.js"},{expected_digest:"c".repeat(64)},{command:"touch outside"},{replacements:[{old:"```js\nold\n```",new:"new"}]}]) {
      const args={...valid,...extra};
      expect(()=>bindAgentRepairProposal(proposal(args),source)).toThrow();
      expect(new Validator().validate(args,JSON.parse(JSON.stringify(REPAIR_PROPOSAL_TOOL.function.parameters))).valid).toBe(false);
    }
    expect(()=>bindAgentRepairProposal({...proposal(valid),name:"write_file"},source)).toThrow("propose_repair");
  });
  it("keeps missing-source requests bounded and uses the registered reader",()=>{
    expect(bindAgentRepairProposal(proposal({kind:"source",path:"src/types.js",start_line:3,max_bytes:1000,cursor:"continued",reason:"Read the imported type"}),source)).toMatchObject({call:{name:"read_file",arguments:{path:"src/types.js",start_line:3,max_bytes:1000,cursor:"continued"}}});
    for(const args of [{kind:"source",path:"src/types.js"},{kind:"source",path:"src/types.js",max_bytes:5000,reason:"More source"}])expect(()=>bindAgentRepairProposal(proposal(args),source)).toThrow();
  });
  it("can request the full tool view or stop without synthesizing a mutation",()=>{
    expect(bindAgentRepairProposal(proposal({kind:"tools",capability:"workspace_mutation",reason:"Create a required helper"}),source)).toMatchObject({call:{name:"request_capability",arguments:{capability:"workspace_mutation",reason:"Create a required helper"}}});
    expect(bindAgentRepairProposal(proposal({kind:"blocked",reason:"The source needed for this repair is not available"}),source)).toEqual({blocked:"The source needed for this repair is not available"});
    expect(()=>bindAgentRepairProposal(proposal({kind:"blocked",reason:"Blocked",replacements:[{old:["old"],new:["new"]}]}),source)).toThrow();
  });
});
