import { parse } from "@babel/parser";
import { isBuiltin } from "node:module";
import path from "node:path";
import type { AgentSourceQuote, AgentTask } from "../../shared/contracts.js";
import { PermissionError } from "../harness/path-guard.js";

export interface AgentDependencyConstraint { kind: "no_new_dependencies"; requirementId: string; source: AgentSourceQuote }

/** Recognize only unconditional standalone instructions. Other constraints retain semantic review. */
export function agentDependencyConstraints(task: AgentTask): AgentDependencyConstraint[] {
  return task.snapshot.requirements.flatMap(requirement => {
    if (requirement.state !== "active" || requirement.kind !== "preserve") return [];
    const message = task.snapshot.messages.find(item => item.id === requirement.source.messageId);
    if (!message || ["pending", "status", "evidence"].includes(message.disposition) || message.content.slice(requirement.source.start, requirement.source.end) !== requirement.source.quote) return [];
    const matches = /^(?:do\s+not|don't|never|must\s+not)\s+(?:add|install|introduce)\s+(?:(?:any|new|external)\s+)?dependencies[.!]?$/i.test(requirement.source.quote.trim());
    return matches ? [{ kind: "no_new_dependencies" as const, requirementId: requirement.id, source: requirement.source }] : [];
  });
}

const manifests = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "pyproject.toml", "requirements.txt", "poetry.lock", "uv.lock", "Pipfile", "Pipfile.lock", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "Gemfile.lock", "composer.json", "composer.lock"]);
const js = /\.[cm]?[jt]sx?$/i;
const code = /\.(?:py|rb|go|rs|java|kt|cs|php|swift|c|h|cpp|sh)$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Parse dependency syntax, never execute source. This does not prove arbitrary runtime behavior. */
function references(filename: string, bytes: Buffer): Set<string> {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const tree = parse(source, { sourceType: "unambiguous", createImportExpressions: true, plugins: ["jsx", ...(/\.[cm]?tsx?$/i.test(filename) ? ["typescript" as const] : [])] });
  const refs = new Set<string>(), nodes: unknown[] = [tree];
  const add = (value: unknown) => {
    if (object(value) && value.type === "StringLiteral" && typeof value.value === "string") refs.add(`module:${value.value}`);
    else if (object(value) && value.type === "TemplateLiteral" && Array.isArray(value.expressions) && value.expressions.length === 0 && Array.isArray(value.quasis) && object(value.quasis[0]) && object(value.quasis[0].value) && typeof value.quasis[0].value.cooked === "string") refs.add(`module:${value.quasis[0].value.cooked}`);
    else if (object(value) && typeof value.start === "number" && typeof value.end === "number") refs.add(`dynamic:${source.slice(value.start, value.end)}`);
    else refs.add("dynamic:unknown");
  };
  while (nodes.length) {
    const node = nodes.pop();
    if (!object(node) || typeof node.type !== "string") continue;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.source) add(node.source);
    if (node.type === "ImportExpression") add(node.source);
    if (node.type === "CallExpression" && object(node.callee)) {
      const callee = node.callee;
      const loader = callee.type === "Identifier" && callee.name === "require" || callee.type === "MemberExpression" && object(callee.object) && object(callee.property) && (callee.object.name === "module" && callee.property.name === "require" || callee.object.name === "require" && callee.property.name === "resolve");
      if (loader) add(Array.isArray(node.arguments) ? node.arguments[0] : undefined);
    }
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "comments", "leadingComments", "trailingComments", "innerComments"].includes(key)) continue;
      if (Array.isArray(child)) nodes.push(...child);
      else if (object(child)) nodes.push(child);
    }
  }
  return refs;
}

/** Conservative, explicit scope: unchanged manifests and no newly introduced external loading syntax.
 * It is not a language-wide dependency proof. Unsupported changed code fails closed.
 */
export function validateAgentDependencyChange(constraints: AgentDependencyConstraint[] | undefined, filename: string, before: Buffer | undefined, after: Buffer | undefined): void {
  if (!constraints?.length || before && after && before.equals(after) || !before && !after) return;
  const deny = (reason: string): never => { throw new PermissionError(`Dependency constraint ${constraints[0].requirementId}: ${reason}`); };
  if (manifests.has(path.posix.basename(filename))) deny("dependency manifests and lock files must remain unchanged; request an explicit scope revision before editing them.");
  if (!after) return;
  if (!js.test(filename)) {
    if (code.test(filename)) deny("dependency syntax for this language cannot be verified. No file change was applied.");
    return;
  }
  let original: Set<string>, proposed: Set<string>;
  try { original = before ? references(filename, before) : new Set(); }
  catch { original = new Set(); } // Syntax repairs can proceed only without new external loading syntax.
  try { proposed = references(filename, after); }
  catch { deny("the proposed JavaScript or TypeScript could not be parsed. No file change was applied."); }
  for (const ref of proposed!) {
    if (original.has(ref)) continue;
    if (!ref.startsWith("module:")) deny("new computed dependency loading cannot be verified.");
    const module = ref.slice(7);
    if (isBuiltin(module)) continue;
    if (module.startsWith("./") || module.startsWith("../")) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), module));
      if (!resolved.startsWith("../") && !path.posix.isAbsolute(resolved)) continue;
    }
    deny(`a new external module reference is not allowed: ${module}.`);
  }
}
