/**
 * Neutral future seam for pre-model context preparation.
 *
 * This build performs no pre-model preparation step: the gateway sends the
 * run prompt directly. The interface exists so a future step can be slotted
 * in behind `prepare` without touching callers.
 */
import type { GroundingChunk } from "../../shared/contracts.js";

export interface GroundingRequest {
  runId: string;
  text: string;
}

export interface GroundingResult {
  runId: string;
  notes: string[];
  chunks?: GroundingChunk[];
}

export interface GroundingProvider {
  prepare(input: GroundingRequest): Promise<GroundingResult>;
}

