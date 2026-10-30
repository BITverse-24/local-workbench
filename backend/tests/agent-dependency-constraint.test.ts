import { expect, it } from "vitest";
import type { AgentTask } from "../src/shared/contracts.js";
import { agentDependencyConstraints, validateAgentDependencyChange } from "../src/main/agent/dependency-constraint.js";

const text = "Do not add dependencies.";
const task: AgentTask = {taskId:"task",chatId:"chat",workspace:{root:"/project",registeredAt:"now"},status:"open",current:true,snapshot:{schemaVersion:1,taskId:"task",revision:1,messages:[{id:"message",content:text,disposition:"continue"}],requirements:[{id:"preserve-dependencies",kind:"preserve",description:text,source:{messageId:"message",start:0,end:text.length,quote:text},mandatory:true,dependencies:[],acceptance:[{id:"check",description:text,kind:"review"}],state:"active"}]}};
const constraints = agentDependencyConstraints(task);
const check = (after:string,before="export const value = 1;",filename="src/value.js") => validateAgentDependencyChange(constraints,filename,Buffer.from(before),Buffer.from(after));

it("binds an unconditional dependency restriction to exact saved active user source",()=>{
  expect(constraints).toEqual([{kind:"no_new_dependencies",requirementId:"preserve-dependencies",source:task.snapshot.requirements[0].source}]);
  for (const mutate of [(copy:AgentTask)=>{copy.snapshot.requirements[0].state="waived";},(copy:AgentTask)=>{copy.snapshot.messages[0].disposition="evidence";},(copy:AgentTask)=>{copy.snapshot.messages[0].content="quoted log data";}]) {
    const copy=structuredClone(task);mutate(copy);expect(agentDependencyConstraints(copy)).toEqual([]);
  }
  const copy=structuredClone(task),conditional="Do not add dependencies unless needed.";
  copy.snapshot.messages[0].content=conditional;copy.snapshot.requirements[0].source={messageId:"message",start:0,end:conditional.length,quote:conditional};
  expect(agentDependencyConstraints(copy)).toEqual([]);
  // A broad quote on an unrelated requirement must not reintroduce a waived restriction.
  const waived=structuredClone(task);waived.snapshot.requirements[0].state="waived";
  waived.snapshot.requirements.push({...structuredClone(task.snapshot.requirements[0]),id:"repair",kind:"change"});
  expect(agentDependencyConstraints(waived)).toEqual([]);
});
it("accepts ordinary syntax repairs without treating try/catch as a dependency",()=>{
  expect(()=>check('export function load(value) { try { return JSON.parse(value); } catch { return []; } }')).not.toThrow();
  expect(()=>check('export const value = 1;','export const value = ;')).not.toThrow();
  expect(()=>check('import {readFile} from "node:fs"; export const value = 2;')).not.toThrow();
  expect(()=>check('import value from "./other.js"; export default value;')).not.toThrow();
  expect(()=>check('export { value } from "./other.js";')).not.toThrow();
  expect(()=>check('import x from "existing"; export default x;', 'import x from "existing";')).not.toThrow();
});
it.each([
  'import dependency from "new-package";',
  'export {value} from "new-package";',
  'export * from "new-package";',
  'const dependency = require("new-package");',
  'module.require("new-package");',
  'require.resolve("new-package");',
  'async function load() { return import("new-package"); }',
  'async function load(name) { return import(name); }',
  'const dependency = require(name);',
  'const dependency = require(`new-package`);',
  'import dependency from "../../outside.js";',
])("rejects new external or unverifiable dependency syntax: %s",after=>{
  expect(()=>check(after)).toThrow(/Dependency constraint/);
});
it("parses TypeScript and JSX while preserving literal backslashes and import syntax",()=>{
  expect(()=>check('import type {Value} from "new-package"; export const view = <div />;',"export const x: number = 1;","src/view.tsx")).toThrow(/new external module/);
  expect(()=>check('export const value: string = "\\\\value";',"export const x: number = 1;","src/value.ts")).not.toThrow();
  expect(()=>check('export const value = ;')).toThrow(/could not be parsed/);
});
it("keeps dependency manifests unchanged and reports unsupported code checks",()=>{
  expect(()=>check('{"dependencies":{"new":"1"}}','{}','nested/package.json')).toThrow(/manifests/);
  expect(()=>validateAgentDependencyChange(constraints,'package-lock.json',Buffer.alloc(0),undefined)).toThrow(/manifests/);
  expect(()=>check('new==1','old==1','requirements.txt')).toThrow(/manifests/);
  expect(()=>check('import new_package','pass','src/app.py')).toThrow(/cannot be verified/);
  expect(()=>validateAgentDependencyChange([],"src/app.js",undefined,Buffer.from('import x from "new-package";'))).not.toThrow();
});
