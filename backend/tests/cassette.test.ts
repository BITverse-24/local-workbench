import { describe, expect, it } from "vitest";
import { normalizeCassetteRequest, digestNormalizedRequest, createCassetteReplayHandler, type CassetteEntry } from "../../tests/harness/cassette.js";

describe("Cassette Normalization & Replay", () => {
  it("normalizes UUIDs, timestamps, and workspace paths consistently", () => {
    const rawReq1 = {
      model: "qwen/qwen3.5-9b",
      messages: [
        { role: "system", content: "Task task-123e4567-e89b-12d3-a456-426614174000 run:12345678" },
        { role: "user", content: "Work on /private/var/folders/abc/def at 2026-11-03T07:19:05Z in /repo/root/src/index.js" }
      ],
      temperature: 0
    };

    const rawReq2 = {
      model: "qwen/qwen3.5-9b",
      messages: [
        { role: "system", content: "Task task-987f6543-a21c-34d5-b678-112233445566 run:87654321" },
        { role: "user", content: "Work on /private/var/folders/xyz/123 at 2026-11-02T12:00:00Z in /repo/root/src/index.js" }
      ],
      temperature: 0
    };

    const norm1 = normalizeCassetteRequest(rawReq1, "/repo/root");
    const norm2 = normalizeCassetteRequest(rawReq2, "/repo/root");

    expect(norm1).toEqual(norm2);
    expect(digestNormalizedRequest(norm1)).toEqual(digestNormalizedRequest(norm2));
  });

  it("replays recorded responses on matching digest", () => {
    const body = {
      model: "test-model",
      messages: [{ role: "user", content: "Hello /workspace/app run:abcdef01" }]
    };
    const normalized = normalizeCassetteRequest(body, "/workspace");
    const digest = digestNormalizedRequest(normalized);

    const entry: CassetteEntry = {
      seq: 0,
      role: "actor",
      requestDigest: digest,
      request: normalized as any,
      response: {
        status: 200,
        body: { choices: [{ message: { content: "World" } }] }
      }
    };

    const handler = createCassetteReplayHandler([entry], { root: "/workspace" });
    const response = handler("/target/test-model/v1/chat/completions", body, 0);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ choices: [{ message: { content: "World" } }] });
  });

  it("throws divergence on request mismatch", () => {
    const recordedEntry: CassetteEntry = {
      seq: 0,
      role: "actor",
      requestDigest: "sha256:different",
      request: { model: "m", messages: [] },
      response: { status: 200, body: {} }
    };

    const handler = createCassetteReplayHandler([recordedEntry]);
    expect(() => handler("/target/m/v1/chat/completions", { model: "m", messages: [] }, 0)).toThrow(/divergence/);
  });
});
