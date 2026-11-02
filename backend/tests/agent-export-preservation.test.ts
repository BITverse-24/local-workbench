import { describe, expect, it } from "vitest";
import { preservesPublicInterface, validatePublicExports } from "../src/main/agent/export-preservation.js";
import type { AgentTask } from "../src/shared/contracts.js";

describe("Agent public interface preservation",()=>{
  const original=Buffer.from('export function filter() {}\nexport const change = () => {};\n');
  it("rejects the observed wrong-module replacement before it can be applied",()=>{
    const wrong=Buffer.from('import { filter, change } from "./work-orders.js";\nconsole.log(filter, change);\n');
    expect(()=>validatePublicExports(true,"src/work-orders.js",original,wrong)).toThrow(/removes existing exports: filter, change/);
    expect(()=>validatePublicExports(false,"src/work-orders.js",original,wrong)).not.toThrow();
  });
  it("permits implementation changes while retaining static names",()=>{
    const repaired=Buffer.from('export function filter() { return 1; }\nexport const change = () => 2;\n');
    expect(()=>validatePublicExports(true,"module.js",original,repaired)).not.toThrow();
    expect(()=>validatePublicExports(true,"module.js",original,undefined)).toThrow(/removes existing exports/);
    expect(()=>validatePublicExports(true,"module.js",original,Buffer.from("export function {"))).toThrow(/cannot be parsed/);
  });
  it("tracks aliases, default exports, re-exports and destructured bindings",()=>{
    const prefix='const internal=1; export default 1; export { internal as publicName }; export * from "./other.js"; ';
    const before=Buffer.from(prefix+'export const { a, b: renamed } = value;');
    expect(()=>validatePublicExports(true,"module.js",before,Buffer.from(prefix+'export const { a, b: renamed } = value;'))).not.toThrow();
    expect(()=>validatePublicExports(true,"module.js",before,Buffer.from(prefix+'export const { a } = value;'))).toThrow(/renamed/);
  });
  it("requires an active quoted instruction to preserve public behavior",()=>{
    const text="Keep the current design and public behavior.";
    const task={snapshot:{messages:[{id:"message",content:text,disposition:"continue"}],requirements:[{kind:"preserve",state:"active",source:{messageId:"message",start:0,end:text.length,quote:text}}]}} as unknown as AgentTask;
    expect(preservesPublicInterface(task)).toBe(true);
    task.snapshot.requirements[0].source.quote="Keep the public behavior.";
    expect(preservesPublicInterface(task)).toBe(false);
  });
});
