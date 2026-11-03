export type StuckKind =
  | "repeated_action"
  | "malformed_action"
  | "context_limit"
  | "repeated_context_request";

export type Rung =
  | "expand_context"
  | "switch_edit_mode"
  | "resample_t0.5"
  | "correction"
  | "constrained_transport"
  | "symbol_slices_only"
  | "supply_neighbor_symbols"
  | "stop";

export const LADDER: Record<StuckKind, Rung[]> = {
  repeated_action: ["expand_context", "switch_edit_mode", "resample_t0.5", "stop"],
  malformed_action: ["correction", "constrained_transport", "stop"],
  context_limit: ["symbol_slices_only", "stop"],
  repeated_context_request: ["supply_neighbor_symbols", "stop"],
};

export interface EscalationResult {
  action: Rung;
  step: number;
  totalSteps: number;
}

/**
 * Returns the escalation action for the given stuck kind and attempt count.
 * The ladder advances with each attempt; once the ladder reaches "stop", it stays at "stop".
 */
export function nextEscalation(kind: StuckKind, currentCount: number): EscalationResult {
  const ladder = LADDER[kind] ?? ["stop"];
  const step = Math.min(Math.max(0, currentCount), ladder.length - 1);
  return {
    action: ladder[step],
    step,
    totalSteps: ladder.length,
  };
}
