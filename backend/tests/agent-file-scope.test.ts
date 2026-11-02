import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentFileScopeSchema, assertAgentFileScope, bindAgentFileScope, type AgentFileScope } from "../src/main/agent/file-scope.js";
let root:string;
beforeEach(()=>{root=mkdtempSync(path.join(tmpdir(),"agent-file-scope-"));mkdirSync(path.join(root,"src"));});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
const scope:AgentFileScope={scope:"workspace",operations:["edit_file","write_file"],protected_paths:[],reason:"The user requested project repairs."};
it("allows an unnamed implementation target for workspace repair while retaining operation limits",()=>{
  const bound=bindAgentFileScope(scope,root,["Repair the project and run its tests."]);
  expect(()=>assertAgentFileScope(bound,"edit_file","src/storage.js")).not.toThrow();
  expect(()=>assertAgentFileScope(bound,"delete_file","src/storage.js")).toThrow(/outside/);
  expect(()=>assertAgentFileScope(undefined,"edit_file","src/storage.js")).toThrow(/no saved/);
  expect(()=>assertAgentFileScope({scope:"none",reason:"Inspection only"},"edit_file","src/storage.js")).toThrow(/Inspection only/);
});
it("enforces literal file/directory allow lists and protected-path boundaries",()=>{
  const bound=bindAgentFileScope({...scope,scope:"paths",paths:["./src"],protected_paths:["src/private.js"]},root,["Repair ./src, but do not edit src/private.js."]);
  expect(()=>assertAgentFileScope(bound,"edit_file","src/storage.js")).not.toThrow();
  for (const name of ["src/private.js","src/private.js/child","src-other/file.js","README.md"]) expect(()=>assertAgentFileScope(bound,"edit_file",name)).toThrow(/outside/);
  expect(()=>assertAgentFileScope(bound,"edit_file","src/private.jsx")).not.toThrow();
});
it.each(["invented.js","../outside.js","src/*.js",".","src/.."])("rejects an unbound or unsafe selector: %s",filename=>{
  expect(()=>bindAgentFileScope({...scope,scope:"paths",paths:[filename]},root,["Repair src/value.js."])).toThrow();
});
it("does not match a path substring or a traversal alias as user provenance",()=>{
  expect(()=>bindAgentFileScope({...scope,scope:"paths",paths:["src/value.js"]},root,["Repair other-src/value.js.txt"])).toThrow(/not supplied/);
  expect(()=>bindAgentFileScope({...scope,protected_paths:["src/value.js"]},root,["Repair source files"])).toThrow(/not supplied/);
  expect(()=>bindAgentFileScope({...scope,protected_paths:["src/.."]},root,["Do not edit src/.."])).toThrow(/workspace root/);
});
it("rejects the former Boolean gate and inconsistent selector data",()=>{
  expect(agentFileScopeSchema.safeParse({withinScope:true,reason:"yes"}).success).toBe(false);
  expect(agentFileScopeSchema.safeParse({...scope,scope:"paths",paths:[]}).success).toBe(false);
  expect(agentFileScopeSchema.safeParse({...scope,scope:"none"}).success).toBe(false);
});
