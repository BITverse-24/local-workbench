import { expect, it } from "vitest";
import { Validator } from "jsonschema";
import { conciseAgentTool } from "../src/main/agent/context-packet.js";
import type { AgentToolDefinition } from "../src/shared/contracts.js";

it("compacts schema guidance without removing named fields, constraints, or data",()=>{
  const tool = {type:"function",function:{name:"example",description:"A short tool. More guidance.",parameters:{type:"object",properties:{
    description:{type:"string",description:"Required argument named description",minLength:1},
    mode:{type:"object",description:"Choose this exact data object",enum:[{description:"literal data"}],default:{description:"literal data"}},
    lines:{type:"array",items:{type:"string",format:"multiline",description:"Code lines"}},
  },required:["description","mode"],additionalProperties:false}}} as unknown as AgentToolDefinition;
  const before=structuredClone(tool), compact=conciseAgentTool(tool);
  expect(tool).toEqual(before);
  expect(compact.function.parameters.properties.description).toMatchObject({type:"string",minLength:1});
  expect(compact.function.parameters.properties.mode).toMatchObject({enum:[{description:"literal data"}],default:{description:"literal data"}});
  expect(compact.function.parameters.properties.lines).toMatchObject({items:{format:"multiline"}});
  const validator=new Validator();
  for(const value of [{description:"reason",mode:{description:"literal data"}},{mode:{description:"literal data"}},{description:"",mode:{description:"literal data"}},{description:"reason",mode:{description:"other"}}]) {
    expect(validator.validate(value,JSON.parse(JSON.stringify(compact.function.parameters))).valid).toBe(validator.validate(value,JSON.parse(JSON.stringify(tool.function.parameters))).valid);
  }
});
