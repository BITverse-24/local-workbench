import { z } from "zod";

export const families = ["explain-vs-execute", "conflicting-sources", "fabrication-detection", "instruction-injection", "follow-up-constraint-loss", "approval-flow", "partial-failure", "workspace-isolation", "dependent-operations", "long-tool-output", "ambiguous-units", "stale-revisions"] as const;
const relative = z.string().min(1).refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes("..") && !p.includes("\0"), "Expected contained relative path");
const fixture = z.object({ path: relative, content: z.string(), kind: z.enum(["text", "pdf"]).default("text") }).strict();
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send"), chat: z.string().default("main"), bind: z.string(), text: z.string().max(8000), attachments: z.array(relative).max(10).default([]), temperature: z.number().min(0).max(2).optional(), preferredRoute: z.enum(["draft", "code", "vision", "draft-qwen3", "code-qwen25coder", "vision-qwen25vl"]).optional(), groundingEnabled: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal("settle"), run: z.string(), approvals: z.enum(["approve", "reject", "none", "read-only"]).default("none") }).strict(),
  z.object({ type: z.literal("confirm"), run: z.string(), approved: z.boolean(), bind: z.string().optional() }).strict(),
  z.object({ type: z.literal("cancel"), run: z.string() }).strict(),
  z.object({ type: z.literal("wait"), run: z.string(), event: z.string(), state: z.string().optional(), timeoutMs: z.number().int().positive().max(600000).default(60000) }).strict(),
  z.object({ type: z.literal("inspect"), run: z.string() }).strict(),
  z.object({ type: z.literal("pause"), durationMs: z.number().int().min(0).max(310000) }).strict(),
  z.object({ type: z.literal("ipc"), channel: z.string(), args: z.unknown(), expectError: z.boolean().default(false) }).strict(),
]);
export const checkSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("workspace"), path: relative, expect: z.enum(["unchanged", "modified", "created", "absent"]), pattern: z.string().optional(), flags: z.string().default("") }).strict(),
  z.object({ id: z.string(), type: z.literal("output"), target: z.enum(["assistant", "artifact"]).default("assistant"), run: z.string().optional(), filename: z.string().optional(), contains: z.array(z.string()).default([]), excludes: z.array(z.string()).default([]), pattern: z.string().optional(), flags: z.string().default("i") }).strict(),
  z.object({ id: z.string(), type: z.literal("parser"), path: relative }).strict(),
  z.object({ id: z.string(), type: z.literal("event"), event: z.string(), run: z.string().optional(), minCount: z.number().int().nonnegative().default(1), state: z.string().optional(), tool: z.string().optional() }).strict(),
  z.object({ id: z.string(), type: z.literal("toolResult"), run: z.string().optional(), tool: z.string(), ok: z.boolean(), contains: z.array(z.string()).default([]) }).strict(),
  z.object({ id: z.string(), type: z.literal("semantic"), question: z.string(), sourceFiles: z.array(relative).min(1), expected: z.enum(["yes", "no"]), requireCitation: z.literal(true).default(true) }).strict(),
]);
export const scenarioSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-z0-9][a-z0-9-]+$/),
  family: z.enum(families), complexity: z.enum(["simple", "moderate", "complex"]),
  campaignType: z.enum(["behavioral", "boundary"]).default("behavioral"),
  description: z.string(), objective: z.object({ request: z.string(), intendedOutcome: z.string(), acceptableAlternatives: z.array(z.string()).default([]) }).strict(),
  setup: z.object({ workspace: z.array(fixture).default([]), attachments: z.array(fixture).default([]), knowledgeBase: z.array(fixture).default([]), conversation: z.array(z.object({ chat: z.string(), role: z.enum(["user", "assistant"]), content: z.string() }).strict()).default([]) }).strict(),
  constraints: z.object({ permittedWrites: z.array(relative).default([]), requiresConfirmation: z.array(z.string()).default([]), prohibitedTools: z.array(z.string()).default([]), prohibitedOutput: z.array(z.string()).default([]), noEffectsAfterDecision: z.boolean().default(true) }).strict(),
  actions: z.array(actionSchema).min(1), checks: z.array(checkSchema).min(1), deadlineMs: z.number().int().positive().max(3600000).default(600000),
}).strict().superRefine((s, ctx) => {
  if (s.campaignType === "behavioral" && s.actions.some((a) => a.type === "ipc")) ctx.addIssue({ code: "custom", message: "Direct IPC is restricted to boundary scenarios", path: ["actions"] });
  const runs = new Set<string>();
  for (const [i, a] of s.actions.entries()) {
    if (a.type === "send") {
      if (runs.has(a.bind)) ctx.addIssue({ code: "custom", message: "Duplicate run binding", path: ["actions", i] });
      runs.add(a.bind);
    } else if ("run" in a && !runs.has(a.run)) ctx.addIssue({ code: "custom", message: "Unknown run binding", path: ["actions", i] });
  }
  for (const [i, c] of s.checks.entries()) if ("run" in c && c.run && !runs.has(c.run)) ctx.addIssue({ code: "custom", message: "Unknown check run binding", path: ["checks", i] });
});
export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioAction = z.infer<typeof actionSchema>;
export type Check = z.infer<typeof checkSchema>;
