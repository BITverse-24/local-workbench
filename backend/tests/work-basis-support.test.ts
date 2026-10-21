import { describe, expect, it } from 'vitest';
import { basisSupported } from '../src/main/run/work-orchestrator.js';

describe('acceptance basis support', () => {
  const request = 'Use columns for Valve ID, Equipment ID, observed setting, and decision. Use 2026-10-12 as the review date.';
  it('accepts exact excerpts and ellipsis-abbreviated excerpts in order', () => {
    expect(basisSupported(request, 'columns for Valve ID')).toBe(true);
    expect(basisSupported(request, 'columns for ... observed setting')).toBe(true);
  });
  it('rejects invented, empty, or out-of-order text', () => {
    expect(basisSupported(request, 'columns for ... cost estimate')).toBe(false);
    expect(basisSupported(request, 'review date ... columns for')).toBe(false);
    expect(basisSupported(request, '...')).toBe(false);
  });
});
