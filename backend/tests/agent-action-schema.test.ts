import { expect, it } from "vitest";
import { Validator } from "jsonschema";
import { agentJSONResponseFormat, formatJSONToolMessages } from "../src/main/gateway/model-gateway.js";
import type { AgentToolDefinition } from "../src/shared/contracts.js";

const tools:AgentToolDefinition[] = [
  {type:"function",function:{name:"read_file",description:"Read source",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}}},
  {type:"function",function:{name:"edit_file",description:"Edit observed source",parameters:{type:"object",properties:{path:{type:"string"},replacements:{type:"array",items:{type:"object",properties:{old:{type:"string",format:"multiline"},new:{type:"string",format:"multiline"}},required:["old","new"],additionalProperties:false}}},required:["path","replacements"],additionalProperties:false}}},
];
const call = (name:string,args:unknown) => ({tool_calls:[{name,arguments:args}],content:""});

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
