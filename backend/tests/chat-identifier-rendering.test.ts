import { describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

function render(text: string): string {
  const result=buildSync({stdin:{contents:`
    import React from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import ChatArea from './frontend/src/components/ChatArea';
    module.exports=renderToStaticMarkup(<ChatArea messages={[{id:'message',role:'assistant',text:${JSON.stringify(text)}}]}/>);
  `,resolveDir:path.resolve('.'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',packages:'external',write:false});
  const module={exports:''};
  runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:createRequire(import.meta.url),console,process});
  return module.exports;
}

describe('Chat identifier display',()=>{
  it('preserves identifiers and paths with underscores',()=>{
    const text='UI_ROUTING_OK AFTER_UI .harness_backups/run_id/smoke.txt sensor__reading__value';
    const html=render(text);
    expect(html).toContain(text);
    expect(html).not.toContain('<em');
    expect(html).not.toContain('<strong');
  });
  it('preserves Unicode identifiers with underscores',()=>{
    expect(render('試験_番号_値')).toContain('試験_番号_値');
  });
  it('displays escaped Markdown identifiers without extra backslashes',()=>{
    const html=render('UI\\_ARTIFACT\\_CHECK \\_literal\\_');
    expect(html).toContain('UI_ARTIFACT_CHECK _literal_');
    expect(html).not.toContain('<em');
  });
  it('still renders standalone emphasis, bold and inline code',()=>{
    const html=render('_review needed_ __required value__ `UI_ROUTING_OK`');
    expect(html).toMatch(/<em[^>]*>review needed<\/em>/);
    expect(html).toMatch(/<strong[^>]*>required value<\/strong>/);
    expect(html).toMatch(/<code[^>]*>UI_ROUTING_OK<\/code>/);
  });
});
