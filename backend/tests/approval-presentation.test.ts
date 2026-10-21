import { describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

function render(kind: string, expired = false, prompt = 'Review action', mounted?: {onApprove:()=>void;listeners:Map<string,(event:any)=>void>}) {
  const result = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import Modal from './frontend/src/components/ConfirmationModal';
    module.exports = renderToStaticMarkup(<Modal open action={{actionId:'action', runId:'e7d75651-4301-423b-80df-53630054142a', kind:${JSON.stringify(kind)}, prompt:${JSON.stringify(prompt)}, preview:'print(1)', expiresAt:${JSON.stringify(new Date(Date.now() + (expired ? -1000 : 300000)).toISOString())}}} runState="awaiting_confirmation" onApprove={()=>approve()} onReject={()=>{}} onClose={()=>{}}/>);
  `, resolveDir: path.resolve('.'), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false });
  const module = { exports: '' };
  const require=createRequire(import.meta.url),effects:Array<()=>unknown>=[];
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports,
    require:(name:string)=>name==='react'&&mounted?{...require(name),useEffect:(effect:()=>unknown)=>effects.push(effect)}:require(name),
    approve:mounted?.onApprove??(()=>{}),console,process,
    window:{addEventListener:(name:string,listener:(event:any)=>void)=>mounted?.listeners.set(name,listener),removeEventListener:()=>{},setInterval:()=>0,clearInterval:()=>{}},
  });
  for(const effect of effects)effect();
  return module.exports;
}

describe('Approval presentation', () => {
  it('does not approve when Enter is used on the details toggle or another control',()=>{
    let approvals=0;
    const listeners=new Map<string,(event:any)=>void>();
    render('plan_approval',false,'Full action details',{onApprove:()=>approvals++,listeners});
    const keydown=listeners.get('keydown')!;
    for(const tag of ['summary','button','input','textarea','select','a','[contenteditable="true"]']){
      let prevented=false;
      keydown({key:'Enter',target:{closest:(selector:string)=>selector.split(', ').includes(tag)?{}:null},preventDefault:()=>{prevented=true;}});
      expect(approvals).toBe(0);expect(prevented).toBe(false);
    }
    let prevented=false;
    keydown({key:'Enter',target:{closest:()=>null},preventDefault:()=>{prevented=true;}});
    expect(approvals).toBe(1);expect(prevented).toBe(true);
  });
  it('uses a short action-plan title and keeps long commands in bounded details',()=>{
    const prompt='Review Agent Plan (Run `python3 -c "'+ 'print(123);'.repeat(300)+'"`)';
    const html=render('plan_approval',false,prompt);
    const heading=html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)![1];
    expect(heading).toBe('Review action plan');
    expect(html).toContain('Action details');expect(html).toContain('print(123);');
    expect(html).toContain('max-h-28 overflow-auto');expect(html).toContain('execution-plan.md');
    expect(html).toContain('Approve plan');expect(html).toContain('role="dialog"');
  });
  it.each([
    ['generate_docx','Create Word document'],['generate_xlsx','Create spreadsheet'],
    ['execute_python','Review Python script'],['uncontained_python','Review Python access'],
  ])('keeps the %s title brief even when the prompt includes code',(kind,title)=>{
    const html=render(kind,false,'def summarize(path):\n    return '+ 'very_long_expression+'.repeat(150)+'1');
    expect(html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)![1]).toBe(title);
    expect(html).not.toContain('def summarize(path):');
  });
  it('keeps approval audit metadata out of the popup, including historical prompts', () => {
    const digest = 'fcb03a20d42c283efce75387674ac789e4ad0ea65faa69ffe59a2b60278b38a8';
    const prompt = `Approve Python without OS isolation? Run e7d75651-4301-423b-80df-53630054142a; source SHA-256 ${digest}; inputs vendor-maintenance-log.csv:${digest}, intermediate/repair-sources/${digest}/task.py:${digest}.`;
    const html = render('uncontained_python', false, prompt);
    for (const internal of ['e7d75651', 'SHA-256', digest, 'intermediate/repair-sources/', 'awaiting_confirmation', 'Action details']) {
      expect(html).not.toContain(internal);
    }
    expect(html).toContain('Approval applies only to this script');
    expect(html).toContain('can access files and the network');
    expect(html).toMatch(/<details(?![^>]*\bopen)[^>]*>[\s\S]*?<summary[^>]*>View script<\/summary>/);
    expect(html).toContain('Copy code');
    expect(html).toContain('print');
    expect(html).toContain('Approve &amp; execute script');
  });
  it('names fallback execution and explains actual OS limits', () => {
    const html = render('uncontained_python');
    expect(html).toContain('Python execution without OS isolation');
    expect(html).toContain('Approve &amp; execute script');
    expect(html).toContain('can access files and the network with your user permissions');
    expect(html).not.toContain('Excel spreadsheet generation');
    expect(html).not.toContain('Sandboxed execution');
  });
  it('does not claim isolation before the Python runner has probed it', () => {
    const html = render('execute_python');
    expect(html).toContain('separate approval is required');
    expect(html).not.toContain('Sandboxed execution');
  });
  it('disables expired approval', () => {
    const html = render('uncontained_python', true);
    expect(html).toMatch(/disabled=""[^>]*>[\s\S]*?Approve &amp; execute script/);
  });
});
