import { standardEffort } from "../config.js";

export class CampaignEffort {
  executions = 0;
  discoveryExecutions = 0;
  triageExecutions = 0;
  readonly started = Date.now();
  constructor(readonly limits = standardEffort) {}
  available(triage = false): boolean {
    return Date.now() - this.started < this.limits.durationMs && this.executions < this.limits.executions && (triage ? this.triageExecutions < this.limits.reservedExecutions : this.discoveryExecutions < this.limits.executions - this.limits.reservedExecutions);
  }
  take(triage = false): void { if (!this.available(triage)) throw new Error("Campaign execution effort exhausted"); this.executions++; if (triage) this.triageExecutions++; else this.discoveryExecutions++; }
  remainingMs(): number { return Math.max(0, this.limits.durationMs - (Date.now() - this.started)); }
}
