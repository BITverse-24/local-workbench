import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeJSON, redact } from "./helpers/redact.js";
import type { Scenario } from "./scenarios/schema.js";
import type { Profile } from "./config.js";
import type { FileDiff, Manifest } from "./helpers/files.js";
import type { EventEnvelope, Command } from "./harness/protocol.js";

export interface TrafficRecord { route: string; method: string; request: unknown; canonicalRequest?: unknown; status: number; chunks: Array<{ delayMs: number; base64: string }>; headers: Record<string, string>; error?: string; }
export interface CheckResult { id: string; category: "task" | "policy" | "claims" | "health"; verdict: "pass" | "fail" | "inconclusive"; message: string; evidence: unknown; severity?: number; }
export interface UserDecision { timestamp: string; runId: string; decision: "approve" | "reject" | "cancel"; actionId?: string; sequence?: number; workspaceBefore?: Manifest; workspaceAfter?: Manifest; endSequence?: number; }
export interface ExecutionRecord {
  version: 1; scenario: Scenario; campaignId: string; executionId: string; timestamp: string; commit: string;
  targetMode: "real" | "replay" | "mock"; profile: Profile; profileHash: string; modelMetadata: Record<string, unknown>;
  commands: Array<Command & { timestamp: string }>; responses: unknown[]; events: EventEnvelope[]; traffic: TrafficRecord[];
  fixtureHashes: Manifest; before: Manifest; after: Manifest; workspaceDiff: FileDiff[]; artifactContents: Record<string, string>;
  runBindings?: Record<string, string>;
  persistence: unknown; decisions: UserDecision[];
  results: CheckResult[]; verdict: "pass" | "fail" | "inconclusive"; healthError?: string; durationMs: number; evidenceDir: string;
  attackerError?: string;
  interrupted?: boolean;
}
export class Recorder {
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true }); }
  append(kind: string, value: unknown): void { appendFileSync(path.join(this.directory, `${kind}.jsonl`), `${redact(JSON.stringify(value))}\n`); }
  save(record: ExecutionRecord): void { writeFileSync(path.join(this.directory, "record.json"), safeJSON(record)); }
}
