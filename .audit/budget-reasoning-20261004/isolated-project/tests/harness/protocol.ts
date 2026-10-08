import { z } from "zod";
import type { RunEvent } from "../../backend/src/shared/contracts.js";
import type { Scenario } from "../scenarios/schema.js";
import type { ModelRegistryEntry } from "../../backend/src/shared/contracts.js";

export const protocolVersion = 1;
export const commandSchema = z.object({ version: z.literal(1), id: z.number().int().nonnegative(), c: z.enum(["send", "invoke", "wait", "inspect", "shutdown"]), a: z.record(z.unknown()).default({}) }).strict();
export type Command = z.infer<typeof commandSchema>;
export interface EventEnvelope { version: 1; kind: "event"; sequence: number; timestamp: string; monotonicMs: number; event: RunEvent; }
export type WorkerMessage = EventEnvelope | { version: 1; kind: "response"; id: number; ok: boolean; d?: unknown; e?: string } | { version: 1; kind: "ready"; registry: ModelRegistryEntry[]; channels: string[] } | { version: 1; kind: "fatal"; e: string };
export interface WorkerBootConfig { root: string; setup: Scenario["setup"]; campaignType: Scenario["campaignType"]; registry: ModelRegistryEntry[]; embedding: { baseUrl: string; model: string }; schemaPath: string; }
export const terminalStates = new Set(["completed", "partial", "failed", "cancelled", "limit_exceeded"]);
