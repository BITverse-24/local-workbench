import { describe,expect,it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { extractSvgText } from '../src/main/run/images.js';

const require=createRequire(import.meta.url);
const {decision,subjectText}=require('../../scripts/release-flow-c.cjs');
const {taskText}=require('../../scripts/demo-prompt.cjs');
describe('Flow C source and oracle separation',()=>{
  it.each([1,2,3])('keeps answers out of scenario %i prompt',scenario=>{
    const prompt=readFileSync(path.resolve(`demo/flow_c/scenario-${scenario}/prompt.md`),'utf8');
    expect(prompt).not.toMatch(/Class\s*\d+|DN\d+|\d+(?:\.\d+)?\s*bar|non.?compliant|RV-30[123]|U18-[AB]|XV-204/i);
    const submitted=taskText(prompt);expect(submitted).not.toContain('**Chat type:**');expect(submitted).not.toContain('**Files to attach:**');expect(submitted).not.toContain('**Agent workspace:**');expect(submitted.length).toBeGreaterThan(60);
    expect(prompt).not.toContain('expected-results');expect(prompt).not.toContain('release-cases');
    if(scenario===2)expect(prompt).toContain('2026-10-12');
  });
  it.each(['scenario-1/pump-skid-P204.svg','scenario-3/workspace/utility-manifold-U18.svg'])('requires pixels to read the rating in %s',relative=>{
    const bytes=readFileSync(path.resolve('demo/flow_c',relative));expect(bytes.toString()).toContain('data:image/png;base64,');expect(extractSvgText(bytes,null)).not.toMatch(/CLASS\s+150/i);
  });
  it('keeps rules in the spec without supplying the drawing observations',()=>{
    const spec=readFileSync(path.resolve('demo/flow_c/scenario-1/piping-spec-SOP-220.md'),'utf8');expect(spec).toContain('Class 300');expect(spec).toContain('DN100');expect(spec).not.toMatch(/P-204|XV-204|Class 150|DN80/);
  });
  it('binds the current prompts and sources to fixture hashes',()=>{
    const manifest=JSON.parse(readFileSync(path.resolve('scripts/demo-manifest.json'),'utf8'));
    for(const [file,details]of Object.entries(manifest.files) as Array<[string,{sha256:string}]>)if(file.startsWith('flow_c/'))expect(createHash('sha256').update(readFileSync(path.resolve('demo',file))).digest('hex')).toBe(details.sha256);
    expect(manifest.flows.flowC).not.toHaveProperty('recommendation');expect(manifest.flows.flowC).not.toHaveProperty('nonCompliantChecks');
  });
  it('rejects inverted decisions and keeps table subjects separate',()=>{
    const text='| Branch | Observation | Decision |\n| U18-A | DN40 CLASS 150 | NON-COMPLIANT |\n| U18-B | DN50 CLASS 300 | COMPLIANT |';
    expect(decision(subjectText(text,'U18-A'),'fail')).toBe(true);expect(decision(subjectText(text,'U18-A'),'pass')).toBe(false);expect(decision(subjectText(text,'U18-B'),'pass')).toBe(true);expect(decision(subjectText(text,'U18-B'),'fail')).toBe(false);
    expect(decision('test status unknown; keep out of service','unknown')).toBe(true);expect(decision('test status unknown; compliant','unknown')).toBe(false);
  });
});
