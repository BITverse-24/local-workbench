import { describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

function render(kind: string, expired = false) {
  const result = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import Modal from './frontend/src/components/ConfirmationModal';
    module.exports = renderToStaticMarkup(<Modal open action={{actionId:'action', runId:'run', kind:${JSON.stringify(kind)}, prompt:'Review action', preview:'print(1)', expiresAt:${JSON.stringify(new Date(Date.now() + (expired ? -1000 : 300000)).toISOString())}}} runState="awaiting_confirmation" onApprove={()=>{}} onReject={()=>{}} onClose={()=>{}}/>);
  `, resolveDir: path.resolve('.'), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false });
  const module = { exports: '' };
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), console, process });
  return module.exports;
}

describe('Approval presentation', () => {
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
