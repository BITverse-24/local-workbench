import { expect, it } from "vitest";
import { Validator } from "jsonschema";
import { agentJSONResponseFormat, formatJSONToolMessages } from "../src/main/gateway/model-gateway.js";
import type { AgentToolDefinition } from "../src/shared/contracts.js";
import { agentInterpretationFormat, agentRequirementRefinement } from "../src/main/agent/task-interpretation.js";

const tools:AgentToolDefinition[] = [
  {type:"function",function:{name:"read_file",description:"Read source",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}}},
  {type:"function",function:{name:"edit_file",description:"Edit observed source",parameters:{type:"object",properties:{path:{type:"string"},replacements:{type:"array",items:{type:"object",properties:{old:{type:"string",format:"multiline"},new:{type:"string",format:"multiline"}},required:["old","new"],additionalProperties:false}}},required:["path","replacements"],additionalProperties:false}}},
];
const call = (name:string,args:unknown) => ({tool_calls:[{name,arguments:args}],content:""});

it("presents a fixed requirement dimension without unsupported negation or scope-update authority",()=>{
  const schema=agentRequirementRefinement("change","continue").schema,validator=new Validator();
  expect(JSON.stringify(schema)).not.toContain('"not":');
  const requirement={kind:"change",description:"Repair a requested defect",source_id:"s1",checks:[{description:"Requested repair is saved",kind:"review",operation:"semantic",path:null}]};
  const input={disposition:"continue",requirements:[requirement],updates:[],full_suite:false};
  expect(validator.validate(input,schema).valid).toBe(true);
  expect(validator.validate({...input,requirements:[{...requirement,kind:"execute"}]},schema).valid).toBe(false);
  expect(validator.validate({...input,updates:[{operation:"waive",requirementId:"old-requirement",source_id:"s1"}]},schema).valid).toBe(false);
  expect(validator.validate({...input,requirements:[]},schema).valid).toBe(true);
});

it("presents literal-copy checks only for a direct literal-copy request and a suitable obligation",()=>{
  const validator=new Validator();
  const literal={kind:"inspect",description:"Read exact content",source_id:"request",checks:[{description:"Copy the exact content",kind:"inspection",operation:"verbatim_source",path:"note.txt"}]};
  const response={disposition:"continue",requirements:[literal],updates:[],full_suite:false};
  expect(validator.validate(response,agentInterpretationFormat("Repair note.txt.").schema).valid).toBe(false);
  expect(validator.validate(response,agentInterpretationFormat("Read the exact content of note.txt.").schema).valid).toBe(true);
  expect(validator.validate(response,agentRequirementRefinement("inspect","continue","Read the exact content of note.txt.").schema).valid).toBe(true);
  expect(validator.validate({...response,requirements:[{...literal,kind:"preserve"}]},agentRequirementRefinement("preserve","continue","Read the exact content of note.txt; preserve its bytes.").schema).valid).toBe(false);
});

it("binds each JSON action name to its own argument schema and the shared multiline representation",()=>{
  const schema=agentJSONResponseFormat(tools,true).json_schema.schema, validator=new Validator();
  const valid=(data:unknown)=>validator.validate(data,schema).valid;
  expect(valid(call("read_file",{path:"src/app.js"}))).toBe(true);
  expect(valid(call("edit_file",{path:"src/app.js",replacements:[{old:['const pattern = "\\n";'],new:["const enabled = true;",""]}]}))).toBe(true);
  expect(valid(call("read_file",{filename:"src/app.js"}))).toBe(false);
  expect(valid(call("read_file",{path:"src/app.js",replacements:[]}))).toBe(false);
  expect(valid(call("edit_file",{path:"src/app.js"}))).toBe(false);
  expect(valid(call("edit_file",{path:"src/app.js",replacements:[{old:"before",new:"after"}]}))).toBe(false);
  expect(valid(call("not_registered",{}))).toBe(false);
  expect(valid({tool_calls:[],content:"A promise"})).toBe(false);
  expect(valid({tool_calls:[...call("read_file",{path:"a"}).tool_calls,...call("read_file",{path:"b"}).tool_calls],content:""})).toBe(false);
  expect(validator.validate({tool_calls:[],content:"Answer proposal"},agentJSONResponseFormat(tools).json_schema.schema).valid).toBe(true);
  const prompt=formatJSONToolMessages([{role:"user",content:"Repair source"}],tools,true,true);
  expect(prompt[0].content).toContain('"old":{"type":"array"');
  expect(prompt[0].content).not.toContain("undefined");
});
