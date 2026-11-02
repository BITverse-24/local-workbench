import path from "node:path";
import { z } from "zod";
import { PermissionError, resolveSafe } from "../harness/path-guard.js";

const fileOperation = z.enum(["edit_file", "write_file", "delete_file"]);
const paths = z.array(z.string().min(1).max(1024)).max(64);
const reason = z.string().min(1).max(1000);
const changes = { operations: z.array(fileOperation).min(1).max(3), protected_paths: paths, reason };
/** Interpreted task scope. This never replaces concrete approval or policy authority. */
export const agentFileScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("none"), reason }).strict(),
  z.object({ scope: z.literal("workspace"), ...changes }).strict(),
  z.object({ scope: z.literal("paths"), paths: paths.min(1), ...changes }).strict(),
]);
export type AgentFileScope = z.infer<typeof agentFileScopeSchema>;

/** Bind model-selected selectors to literal user source before canonicalizing them. */
export function bindAgentFileScope(scope: AgentFileScope, workspaceRoot: string, sourceTexts: string[]): AgentFileScope {
  if (scope.scope === "none") return scope;
  const bind = (selector: string) => {
    if (/[\0*?\[\]{}]/.test(selector) || selector === "." || selector === "./") throw new PermissionError("Task target selectors must be literal paths; use workspace scope for the whole project.");
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!sourceTexts.some(text => new RegExp(`(^|[^\\w/\\\\.-])${escaped}(?=$|[^\\w/\\\\.-]|\\.(?=\\s|$))`).test(text))) throw new PermissionError(`Task scope path was not supplied by a user instruction: ${selector}.`);
    const canonical = path.relative(resolveSafe(workspaceRoot, "."), resolveSafe(workspaceRoot, selector)).split(path.sep).join("/");
    if (!canonical) throw new PermissionError("A path selector resolves to the workspace root. Select workspace or none scope explicitly.");
    return canonical;
  };
  return { ...scope, ...(scope.scope === "paths" ? { paths: scope.paths.map(bind) } : {}), protected_paths: scope.protected_paths.map(bind) };
}

/** Host membership checks run before approval and again inside the mutation boundary. */
export function assertAgentFileScope(scope: AgentFileScope | undefined, operation: string, canonicalPath: string): void {
  if (!scope || scope.scope === "none") throw new PermissionError(scope?.reason ?? "This task has no saved file-change scope.");
  const within = (selector: string) => canonicalPath === selector || canonicalPath.startsWith(selector + "/");
  if (!scope.operations.includes(operation as z.infer<typeof fileOperation>) || scope.protected_paths.some(within) || scope.scope === "paths" && !scope.paths.some(within)) throw new PermissionError(`The operation is outside the saved task scope: ${operation} ${canonicalPath}.`);
}
