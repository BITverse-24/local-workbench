import { z } from "zod";
import { readFileSync } from "node:fs";
import { sha256 } from "./helpers/files.js";
import type { ModelRegistryEntry } from "../backend/src/shared/contracts.js";

const endpoint = z.string().url().refine((v) => ["http:", "https:"].includes(new URL(v).protocol), "HTTP endpoint required");
export const registryEntrySchema = z.object({
  id: z.string().min(1), taskTypes: z.array(z.enum(["vision", "draft", "code"])).min(1),
  runtime: z.enum(["ollama", "mlx-lm", "llama-server"]), baseUrl: endpoint, model: z.string().min(1),
  capabilities: z.array(z.enum(["text", "image-input", "structured-output", "code-generation"])),
  requestTimeoutMs: z.number().int().positive().max(600000), healthPath: z.literal("/models"), enabled: z.boolean(), maxOutputTokens: z.number().int().positive().optional(),
  contextLength: z.number().int().positive().max(128000).optional(), toolCallingFormat: z.enum(["native", "json"]).optional(), temperature: z.number().min(0).max(2).optional(),
}).strict();
export const providerSchema = z.object({
  name: z.string(), baseUrl: endpoint, model: z.string().min(1), apiKeyEnv: z.string().optional(), maxTokens: z.number().int().positive().max(16384).default(4096),
  temperature: z.number().min(0).max(2).default(0.7), timeoutMs: z.number().int().positive().default(60000),
}).strict();
export const profileSchema = z.object({
  version: z.literal(1), name: z.string(), target: z.object({ registry: z.array(registryEntrySchema).min(1), embedding: z.object({ baseUrl: endpoint, model: z.string().min(1) }).strict() }).strict(),
  attacker: providerSchema.optional(), attackerFallback: providerSchema.optional(), judge: providerSchema.optional(), judgeFallback: providerSchema.optional(), sharedGPU: z.boolean().default(false),
}).strict();
export type Profile = z.infer<typeof profileSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export function loadProfile(file: string): Profile {
  const result = profileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (new Set(result.target.registry.map((m) => m.id)).size !== result.target.registry.length) throw new Error("Duplicate target role IDs");
  return result;
}
export function profileHash(profile: Profile): string { return sha256(JSON.stringify(profile)); }
export function registryForRelay(profile: Profile, origin: string): ModelRegistryEntry[] {
  return profile.target.registry.map((m) => ({ ...m, baseUrl: `${origin}/target/${m.id}/v1` }));
}
export const standardEffort = { executions: 60, attackerCalls: 120, judgeCalls: 60, durationMs: 7200000, reservedExecutions: 20 };
