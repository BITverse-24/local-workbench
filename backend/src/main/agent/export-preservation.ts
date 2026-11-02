import { parse } from "@babel/parser";
import type { AgentTask } from "../../shared/contracts.js";
import { PermissionError } from "../harness/path-guard.js";

/** Only a quoted, active instruction to preserve public behavior activates this
 * narrow static guard. Other preservation obligations still need review. */
export function preservesPublicInterface(task:AgentTask): boolean {
  return task.snapshot.requirements.some(requirement=>{
    if(requirement.state !== "active" || requirement.kind !== "preserve")return false;
    const message=task.snapshot.messages.find(item=>item.id===requirement.source.messageId);
    const quote=requirement.source.quote;
    return Boolean(message && !["pending","status","evidence"].includes(message.disposition) && message.content.slice(requirement.source.start,requirement.source.end)===quote && /\b(?:keep|preserve|retain|maintain)\b/i.test(quote) && /\b(?:public|existing|current)\b/i.test(quote) && /\b(?:behavior|behaviour|api|exports?|interfaces?)\b/i.test(quote));
  });
}

/** Enumerate statically declared ESM exports. This is not a proof of behavior
 * or a complete analysis of CommonJS, dynamic exports, or re-export contents. */
function exportsOf(filename:string,bytes:Buffer): Set<string> {
  const source=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  const tree=parse(source,{sourceType:"unambiguous",plugins:["jsx",...(/\.[cm]?tsx?$/i.test(filename) ? ["typescript" as const] : [])]});
  const names=new Set<string>();
  const binding=(node:any):void=>{
    if(!node)return;
    if(node.type === "Identifier")names.add(node.name);
    else if(node.type === "RestElement")binding(node.argument);
    else if(node.type === "AssignmentPattern")binding(node.left);
    else if(node.type === "ArrayPattern")node.elements.forEach(binding);
    else if(node.type === "ObjectPattern")node.properties.forEach((item:any)=>binding(item.type === "RestElement" ? item.argument : item.value));
  };
  for(const node of tree.program.body) {
    if(node.type === "ExportDefaultDeclaration")names.add("default");
    else if(node.type === "ExportAllDeclaration")names.add(`*:${node.source.value}`);
    else if(node.type === "ExportNamedDeclaration") {
      const declaration=node.declaration as any;
      if(declaration?.type === "VariableDeclaration")declaration.declarations.forEach((item:any)=>binding(item.id));
      else if(declaration?.id)binding(declaration.id);
      for(const specifier of node.specifiers) {
        const exported=(specifier as any).exported;
        if(exported)names.add(exported.name ?? exported.value);
      }
    }
  }
  return names;
}

export function validatePublicExports(enabled:boolean|undefined,filename:string,before:Buffer|undefined,after:Buffer|undefined):void {
  if(!enabled || !before || !/\.[cm]?[jt]sx?$/i.test(filename))return;
  let existing:Set<string>;
  try {existing=exportsOf(filename,before);} catch {return;}
  if(!existing.size)return;
  let proposed:Set<string>;
  try {proposed=after ? exportsOf(filename,after) : new Set();}
  catch {throw new PermissionError(`Public interface preservation: proposed ${filename} cannot be parsed.`);}
  const removed=[...existing].filter(name=>!proposed.has(name));
  if(removed.length)throw new PermissionError(`Public interface preservation: ${filename} removes existing exports: ${removed.join(", ")}. No change was applied.`);
}
