import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { MockHandler } from "./model-relay.js";

export interface CassetteEntry {
  seq: number;
  role?: string;
  requestDigest: string;
  request: {
    model: string;
    messages: unknown[];
    tools?: unknown[];
    temperature?: number;
    [key: string]: unknown;
  };
  response: {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  };
}

const UUID_REGEX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP_REGEX = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g;
const RUN_ID_REGEX = /\b(?:run:[0-9a-f]{8}|r-[0-9a-f]{8,12})\b/gi;
const TASK_ID_REGEX = /\btask-[0-9a-f-]+\b/gi;

/**
 * Normalizes dynamic run/task/call/result IDs, timestamps, and workspace temp paths
 * so requests produce a deterministic digest across executions.
 */
export function normalizeCassetteRequest(value: unknown, root?: string): unknown {
  if (typeof value === "string") {
    let result = value;
    if (root) result = result.split(root).join("<workspace-root>");
    result = result.replace(/\/private\/var\/folders\/[^\s"',;)}\]]+/g, "<temp-path>");
    result = result.replace(/\/tmp\/[^\s"',;)}\]]+/g, "<temp-path>");
    result = result.replace(UUID_REGEX, "<uuid>");
    result = result.replace(RUN_ID_REGEX, "<run-id>");
    result = result.replace(TASK_ID_REGEX, "<task-id>");
    result = result.replace(ISO_TIMESTAMP_REGEX, "<timestamp>");
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCassetteRequest(item, root));
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const sorted = Object.keys(object).sort();
    const normalized: Record<string, unknown> = {};
    for (const key of sorted) {
      normalized[key] = normalizeCassetteRequest(object[key], root);
    }
    return normalized;
  }
  return value;
}

export function digestNormalizedRequest(normalized: unknown): string {
  const json = JSON.stringify(normalized);
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

export function saveCassette(taskId: string, entries: CassetteEntry[], baseDir = path.resolve(process.cwd(), "tests/cassettes")): void {
  const taskDir = path.join(baseDir, taskId);
  mkdirSync(taskDir, { recursive: true });
  for (const entry of entries) {
    const filename = `${String(entry.seq).padStart(3, "0")}.json`;
    writeFileSync(path.join(taskDir, filename), JSON.stringify(entry, null, 2), "utf8");
  }
}

export function loadCassette(taskId: string, baseDir = path.resolve(process.cwd(), "tests/cassettes")): CassetteEntry[] {
  const taskDir = path.join(baseDir, taskId);
  if (!existsSync(taskDir)) {
    throw new Error(`Cassette directory not found for task "${taskId}": ${taskDir}`);
  }
  const files = readdirSync(taskDir).filter((file) => file.endsWith(".json")).sort();
  return files.map((file) => {
    const raw = readFileSync(path.join(taskDir, file), "utf8");
    return JSON.parse(raw) as CassetteEntry;
  });
}

export interface ReplayOptions {
  root?: string;
  allowLooseMatching?: boolean;
}

/**
 * Creates a MockHandler that replays recorded cassette entries sequentially.
 * Validates request digests and throws a clear divergence error on mismatch.
 */
export function createCassetteReplayHandler(entries: CassetteEntry[], options: ReplayOptions = {}): MockHandler {
  let currentIndex = 0;
  return (route: string, body: Record<string, unknown>, index: number) => {
    if (currentIndex >= entries.length) {
      throw new Error(`Cassette replay exhausted at index ${index} (recorded ${entries.length} requests). Extra route: ${route}`);
    }
    const expected = entries[currentIndex++];
    const normalized = normalizeCassetteRequest(body, options.root);
    const actualDigest = digestNormalizedRequest(normalized);

    if (actualDigest !== expected.requestDigest) {
      if (!options.allowLooseMatching) {
        throw new Error(
          `Cassette replay divergence at seq ${expected.seq} (role: ${expected.role ?? "unknown"}):\n` +
          `Expected digest: ${expected.requestDigest}\n` +
          `Actual digest:   ${actualDigest}\n` +
          `Expected request:\n${JSON.stringify(expected.request, null, 2)}\n` +
          `Actual request (normalized):\n${JSON.stringify(normalized, null, 2)}`
        );
      }
    }

    return {
      status: expected.response.status,
      body: expected.response.body,
      contentType: expected.response.headers?.["content-type"] ?? "application/json"
    };
  };
}
