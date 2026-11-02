import { createHash } from "node:crypto";
import { z } from "zod";
import { countLocalAgentRequest, type LocalPromptCount } from "./local-token-counter.js";
import { getDb } from "../persistence/db.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({ endpoint: z.string().url(), modelIdentity: z.string().min(1), providerModel: z.string().min(1),
  transport: z.enum(["native", "json"]), templateDigest: digest, contextLimit: z.number().int().positive() }).strict();
export type AgentCountingBinding = z.infer<typeof bindingSchema>;
const countSchema = z.object({ inputTokens: z.number().int().positive(), renderedDigest: digest,
  assetDigests: z.record(digest), templateDigest: digest,
  counterIdentity: z.literal("huggingface-tokenizers-0.2.0/jinja-0.5.11") }).strict();
const probeNames = ["plain", "tools", "tool_result", "unicode"] as const;
type ProbeName = typeof probeNames[number];
const verificationSchema = z.object({ schemaVersion: z.literal(1), binding: bindingSchema,
  counterIdentity: countSchema.shape.counterIdentity, assetDigests: z.record(digest), verifiedAt: z.string().datetime(),
  probes: z.array(z.object({ name: z.enum(probeNames), requestDigest: digest, inputTokens: z.number().int().positive() }).strict()).length(4),
}).strict();
export type AgentCountingVerification = z.infer<typeof verificationSchema>;
export interface AgentCountingProfile {
  assetsDir: string;
  activeTemplate: string;
  verification: AgentCountingVerification;
}
export class AgentAdmissionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "AgentAdmissionError"; }
}
export class AgentRequestTooLargeError extends AgentAdmissionError {}
function verificationKey(binding: AgentCountingBinding): string {
  return `agent-counting:${createHash("sha256").update(JSON.stringify([binding.endpoint, binding.providerModel, binding.transport])).digest("hex")}`;
}
/** Setup evidence is host state, not a renderer-editable application setting. */
export function saveAgentCountingVerification(value: AgentCountingVerification): void {
  const verified = verificationSchema.parse(value);
  getDb().prepare("INSERT INTO kv_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(verificationKey(verified.binding), JSON.stringify(verified));
}
export function loadAgentCountingVerification(binding: AgentCountingBinding): AgentCountingVerification | undefined {
  const row = getDb().prepare("SELECT value FROM kv_meta WHERE key=?").get(verificationKey(binding)) as { value: string } | undefined;
  if (!row) return;
  return verificationSchema.parse(JSON.parse(row.value));
}
export function invalidateAgentCountingVerification(binding: AgentCountingBinding): void {
  getDb().prepare("DELETE FROM kv_meta WHERE key=?").run(verificationKey(binding));
}
export function assertSavedAgentCountingVerification(profile: AgentCountingProfile): void {
  const saved = loadAgentCountingVerification(profile.verification.binding);
  if (!saved || !equal(saved, profile.verification)) throw new AgentAdmissionError("Agent counting setup is missing or expired. Verify the selected model and transport first.");
}
export interface AgentAdmissionReceipt {
  countingMethod: "exact";
  requestDigest: string;
  inputTokens: number;
  outputTokens: number;
  safetyTokens: 512;
  contextLimit: number;
  renderedDigest: string;
  templateDigest: string;
  assetDigests: Record<string, string>;
  counterIdentity: LocalPromptCount["counterIdentity"];
  binding: AgentCountingBinding;
}
export function preparedRequestDigest(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function equal(left: unknown, right: unknown): boolean {
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return left === right;
  const a = Object.entries(left).sort(([x], [y]) => x.localeCompare(y)), b = Object.entries(right).sort(([x], [y]) => x.localeCompare(y));
  return a.length === b.length && a.every(([key, value], i) => b[i][0] === key && equal(value, b[i][1]));
}

/** Fixed setup probes contain no task data. The host must establish the active server template separately. */
export async function verifyLocalAgentCounter(options: {
  binding: AgentCountingBinding;
  assetsDir: string;
  activeTemplate: string;
  probes: Array<{ name: ProbeName; payload: Record<string, unknown> }>;
  providerProbe: (payload: Record<string, unknown>) => Promise<{ inputTokens?: number }>;
  signal?: AbortSignal;
}): Promise<AgentCountingVerification> {
  const binding = bindingSchema.parse(options.binding);
  if (options.probes.length !== 4 || new Set(options.probes.map(probe => probe.name)).size !== 4 || probeNames.some(name => !options.probes.some(probe => probe.name === name))) throw new Error("Counting setup requires all four fixed probes for the selected transport.");
  let reference: LocalPromptCount | undefined;
  const probes: AgentCountingVerification["probes"] = [];
  for (const probe of options.probes) {
    options.signal?.throwIfAborted();
    if (probe.payload.model !== binding.providerModel) throw new Error("Counting probe selects a different model.");
    const count = await countLocalAgentRequest({ assetsDir: options.assetsDir, activeTemplate: options.activeTemplate, payload: probe.payload, signal: options.signal });
    if (count.templateDigest !== binding.templateDigest) throw new Error("The local template differs from the active server template.");
    if (reference && !equal(reference.assetDigests, count.assetDigests)) throw new Error("Tokenizer assets changed during setup.");
    const usage = await options.providerProbe(probe.payload);
    if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens !== count.inputTokens) throw new Error(`Counting setup failed: ${probe.name} local/provider input counts differ or usage is missing.`);
    reference = count;
    probes.push({ name: probe.name, requestDigest: preparedRequestDigest(probe.payload), inputTokens: count.inputTokens });
  }
  return verificationSchema.parse({ schemaVersion: 1, binding, counterIdentity: reference!.counterIdentity,
    assetDigests: reference!.assetDigests, verifiedAt: new Date().toISOString(), probes });
}

/** Called only after the final transport payload has been prepared. Estimates cannot enter this path. */
export async function admitLocalAgentRequest(options: {
  payload: Record<string, unknown>;
  binding: AgentCountingBinding;
  verification: AgentCountingVerification;
  assetsDir: string;
  activeTemplate: string;
  signal?: AbortSignal;
}): Promise<AgentAdmissionReceipt> {
  const binding = bindingSchema.parse(options.binding), verified = verificationSchema.parse(options.verification);
  if (!equal(binding, verified.binding)) throw new Error("Model, endpoint, template, transport, or context changed. Verify counting again.");
  if (options.payload.model !== binding.providerModel) throw new Error("Prepared request selects a different model.");
  const outputTokens = z.number().int().positive().max(2048).parse(options.payload.max_tokens);
  const count = countSchema.parse(await countLocalAgentRequest(options));
  if (count.templateDigest !== binding.templateDigest || !equal(count.assetDigests, verified.assetDigests) || count.counterIdentity !== verified.counterIdentity) throw new Error("Tokenizer or template changed. Verify counting again.");
  const contextLimit = Math.min(8192, binding.contextLimit);
  if (count.inputTokens + outputTokens + 512 > contextLimit) throw new AgentRequestTooLargeError("Agent request exceeds its verified context limit. Reduce the evidence or split the step.");
  return { ...count, countingMethod: "exact", binding, outputTokens, safetyTokens: 512, contextLimit, requestDigest: preparedRequestDigest(options.payload) };
}

export interface AgentVisionAdmissionReceipt {
  countingMethod: "vision_estimate";
  requestDigest: string;
  inputTokens: number;
  outputTokens: number;
  safetyTokens: 512;
  contextLimit: number;
  assetDigests: Record<string, string>;
  counterIdentity: "file-extension-estimate-v1";
  binding: { endpoint: string; modelIdentity: string; providerModel: string; transport: "vision" };
}
/** User-approved temporary vision exception. This is never labelled as an exact count. */
export function admitEstimatedAgentVisionRequest(options: { payload: Record<string, unknown>; endpoint: string; contextLimit: number; extension: string }): AgentVisionAdmissionReceipt {
  const messages = z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.enum(["text", "image_url"]), text: z.string().optional(), image_url: z.unknown().optional() }).strict())]) }).strict()).parse(options.payload.messages);
  const imageTokens: Record<string, number> = { ".png": 2560, ".jpg": 2560, ".jpeg": 2560, ".webp": 2560, ".gif": 2560, ".pdf": 3072, ".svg": 2560 };
  let images = 0;
  const text = messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => {
    if (part.type === "image_url") { images++; return ""; } return part.text ?? "";
  }).join("\n")).join("\n");
  if (!images) throw new AgentAdmissionError("A vision estimate requires host-prepared image parts.");
  const inputTokens = Math.ceil(Buffer.byteLength(text) / 3) + messages.length * 32 + images * (imageTokens[options.extension.toLowerCase()] ?? 3072);
  const outputTokens = z.number().int().positive().max(2048).parse(options.payload.max_tokens);
  const contextLimit = Math.min(8192, z.number().int().positive().parse(options.contextLimit));
  if (inputTokens + outputTokens + 512 > contextLimit) throw new AgentRequestTooLargeError("The vision estimate exceeds the context limit. Select fewer pages or views.");
  const model = z.string().min(1).parse(options.payload.model);
  return { countingMethod: "vision_estimate", inputTokens, outputTokens, contextLimit, safetyTokens: 512,
    requestDigest: preparedRequestDigest(options.payload), assetDigests: {}, counterIdentity: "file-extension-estimate-v1",
    binding: { endpoint: options.endpoint, modelIdentity: `configured:${model}`, providerModel: model, transport: "vision" } };
}

/** Recheck at dispatch so neither fallback formatting nor streaming setup can reuse a stale receipt. */
export function assertAgentAdmissionReceipt(receipt: AgentAdmissionReceipt, payload: Record<string, unknown>, binding: AgentCountingBinding): void {
  if (receipt.requestDigest !== preparedRequestDigest(payload) || !equal(receipt.binding, binding)) throw new Error("Prepared Agent request changed after admission.");
}

/** A mismatch invalidates the profile before any returned action can execute. Missing usage cannot validate it. */
export function assertAgentProviderUsage(receipt: AgentAdmissionReceipt, inputTokens: number | undefined, tolerance = 0): void {
  if (typeof inputTokens !== "number" || !Number.isSafeInteger(inputTokens) || Math.abs(inputTokens - receipt.inputTokens) > tolerance) throw new Error("Provider prompt usage differs from the admitted count or is missing. Invalidate counting verification and stop this Agent run.");
}
