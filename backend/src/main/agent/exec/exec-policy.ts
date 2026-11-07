export interface ExecObserveState {
  mode: "exec" | "native";
  execTurns?: number;
  failures: number;
  noProgress: number;
  reason?: string;
}

export interface ExecOutcome {
  ok: boolean;
  error?: {
    kind: "syntax" | "runtime" | "timeout" | "budget" | "empty_parse" | "tool_error" | "escalated";
    message: string;
    line?: number;
  };
  escalated?: boolean;
  contextLimit?: boolean;
  hasTextOutput?: boolean;
  newSourceDigests?: string[];
}

export function defaultExecObserveState(initialMode: "exec" | "native" = "exec"): ExecObserveState {
  return {
    mode: initialMode,
    failures: 0,
    noProgress: 0,
  };
}

/**
 * Pure policy transition for the Agent observe phase:
 * - Once in 'native' mode, remains sticky (never flips back to 'exec' for the task).
 * - Explicit escalation or context limit immediately transitions to 'native'.
 * - 2 consecutive script failures transition to 'native'.
 * - Calling text(...) with a distilled observation transitions to 'native' for delivery.
 * - Reaching maximum observe turns (default 2) transitions to 'native'.
 * - 2 consecutive runs with no new source digests transition to 'native'.
 * - Successful script execution with new evidence resets failure & noProgress counters.
 */
export function nextObserveState(current: ExecObserveState, outcome: ExecOutcome): ExecObserveState {
  if (current.mode === "native") {
    return current;
  }

  const currentTurns = current.execTurns ?? 0;

  if (outcome.escalated) {
    return {
      mode: "native",
      execTurns: currentTurns,
      failures: current.failures,
      noProgress: current.noProgress,
      reason: outcome.error?.message || "Model explicitly escalated to native tools.",
    };
  }

  if (outcome.contextLimit) {
    return {
      mode: "native",
      execTurns: currentTurns,
      failures: current.failures,
      noProgress: current.noProgress,
      reason: "Observe payload reached context limit; fallback to native tools.",
    };
  }

  if (!outcome.ok) {
    const nextFailures = current.failures + 1;
    if (nextFailures >= 2) {
      return {
        mode: "native",
        execTurns: currentTurns,
        failures: nextFailures,
        noProgress: current.noProgress,
        reason: `Two consecutive script failures: ${outcome.error?.message || "unknown script error"}`,
      };
    }
    return {
      mode: "exec",
      execTurns: currentTurns,
      failures: nextFailures,
      noProgress: current.noProgress,
      reason: outcome.error?.message,
    };
  }

  // Script succeeded
  const turns = currentTurns + 1;
  const maxTurns = Number(process.env.WORKBENCH_AGENT_EXEC_MAX_TURNS) || 2;

  if (outcome.hasTextOutput) {
    return {
      mode: "native",
      execTurns: turns,
      failures: 0,
      noProgress: 0,
      reason: "Observe script distilled final observation; transitioning to native mode for delivery.",
    };
  }

  const discoveredNew = (outcome.newSourceDigests?.length ?? 0) > 0;
  if (discoveredNew) {
    if (turns >= maxTurns) {
      return {
        mode: "native",
        execTurns: turns,
        failures: 0,
        noProgress: 0,
        reason: `Reached maximum Code Mode observe turns (${maxTurns}); transitioning to native mode for delivery.`,
      };
    }
    return {
      mode: "exec",
      execTurns: turns,
      failures: 0,
      noProgress: 0,
    };
  }

  const nextNoProgress = current.noProgress + 1;
  if (nextNoProgress >= 2 || turns >= maxTurns) {
    return {
      mode: "native",
      execTurns: turns,
      failures: 0,
      noProgress: nextNoProgress,
      reason: "Two consecutive scripts executed with no new source evidence discovered.",
    };
  }

  return {
    mode: "exec",
    execTurns: turns,
    failures: 0,
    noProgress: nextNoProgress,
  };
}
