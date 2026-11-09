import { describe, it, expect } from "vitest";
import { defaultExecObserveState, nextObserveState, type ExecObserveState } from "../src/main/agent/exec/exec-policy.js";

describe("Exec Policy State Transitions", () => {
  it("initializes with default state", () => {
    const state = defaultExecObserveState("exec");
    expect(state).toEqual({ mode: "exec", failures: 0, noProgress: 0 });
  });

  it("increments failures on first failure and stays in exec mode", () => {
    const s0 = defaultExecObserveState("exec");
    const s1 = nextObserveState(s0, {
      ok: false,
      error: { kind: "syntax", message: "Unexpected token '{'", line: 2 },
    });
    expect(s1.mode).toBe("exec");
    expect(s1.failures).toBe(1);
    expect(s1.reason).toContain("Unexpected token");
  });

  it("transitions to native mode after 2 consecutive failures", () => {
    const s0: ExecObserveState = { mode: "exec", failures: 1, noProgress: 0 };
    const s1 = nextObserveState(s0, {
      ok: false,
      error: { kind: "runtime", message: "TypeError: tools.unknown is not a function" },
    });
    expect(s1.mode).toBe("native");
    expect(s1.failures).toBe(2);
    expect(s1.reason).toContain("Two consecutive script failures");
  });

  it("resets failures on a successful execution with new evidence", () => {
    const s0: ExecObserveState = { mode: "exec", failures: 1, noProgress: 1 };
    const s1 = nextObserveState(s0, {
      ok: true,
      newSourceDigests: ["a1b2c3d4e5f6"],
    });
    expect(s1.mode).toBe("exec");
    expect(s1.failures).toBe(0);
    expect(s1.noProgress).toBe(0);
  });

  it("tracks noProgress and transitions to native after 2 consecutive runs with no new evidence", () => {
    const s0 = defaultExecObserveState("exec");
    const s1 = nextObserveState(s0, { ok: true, newSourceDigests: [] });
    expect(s1.mode).toBe("exec");
    expect(s1.noProgress).toBe(1);

    const s2 = nextObserveState(s1, { ok: true, newSourceDigests: [] });
    expect(s2.mode).toBe("native");
    expect(s2.noProgress).toBe(2);
    expect(s2.reason).toContain("no new source evidence");
  });

  it("immediately transitions to native when model calls escalate()", () => {
    const s0 = defaultExecObserveState("exec");
    const s1 = nextObserveState(s0, {
      ok: false,
      escalated: true,
      error: { kind: "escalated", message: "Need manual step-by-step control" },
    });
    expect(s1.mode).toBe("native");
    expect(s1.reason).toContain("Need manual step-by-step control");
  });

  it("remains sticky once in native mode", () => {
    const s0: ExecObserveState = { mode: "native", failures: 2, noProgress: 0, reason: "prior failure" };
    const s1 = nextObserveState(s0, { ok: true, newSourceDigests: ["new_digest"] });
    expect(s1.mode).toBe("native");
    expect(s1).toBe(s0);
  });
});
