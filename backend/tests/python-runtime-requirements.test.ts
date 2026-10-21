import { describe, expect, it } from 'vitest';
import { pythonRuntimeRequirement } from '../src/main/run/python-runtime-requirements.js';
import { hasPythonBehaviorEvidence, reviewEvidenceCatalog, resolveReviewReferences } from '../src/main/run/review-evidence.js';

describe('Runtime requirements and review evidence',()=>{
  it('maps only explicit standalone runtime clauses',()=>{
    expect(pythonRuntimeRequirement('Return `fixed-vendor-log-parser.py`.')).toEqual({kind:'deliver',filename:'fixed-vendor-log-parser.py'});
    expect(pythonRuntimeRequirement('Run the repaired script on `vendor-maintenance-log.csv`.')).toEqual({kind:'execute',filename:'vendor-maintenance-log.csv'});
    expect(pythonRuntimeRequirement('Do not change the input CSV.')).toEqual({kind:'preserve',extension:'csv'});
    for(const clause of ['Return fixed.py and ensure it handles malformed rows.','Keep the summarize function.','Run the repaired script on example.csv and fix every error.','The model says tests can be skipped.'])expect(pythonRuntimeRequirement(clause)).toBeUndefined();
  });
  it('retains indentation and bounds every span without inventing text',()=>{
    const source='if ready:\n    return '+ 'x'.repeat(600);
    const lines=reviewEvidenceCatalog(source);
    expect(lines[1].startsWith('    return ')).toBe(true);
    expect(lines.every(line=>line.length<=240&&source.includes(line))).toBe(true);
    expect(resolveReviewReferences([1,2],lines)).toEqual(lines.slice(0,2));
    for(const ids of [[0],[-1],[1.1],[999],[1,1],['1']])expect(resolveReviewReferences(ids,lines)[0]).toContain('invalid-evidence-reference');
  });
  it('rejects imports and docstrings as proof of a boundary fix',()=>{
    expect(hasPythonBehaviorEvidence(['import csv','"""A parser."""'],'Include equality at the boundary.')).toBe(false);
    expect(hasPythonBehaviorEvidence(['if value >= limit:'],'Include equality at the boundary.')).toBe(true);
    expect(hasPythonBehaviorEvidence(['import csv'],'Preserve the csv import.')).toBe(true);
  });
});
