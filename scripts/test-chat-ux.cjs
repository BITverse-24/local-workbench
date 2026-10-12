// Run after npm run build: env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-chat-ux.cjs
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const out=process.env.WORKBENCH_UX_OUTPUT||path.join(os.tmpdir(),'workbench-ux');fs.mkdirSync(out,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:720,useContentSize:true,webPreferences:{preload:path.resolve(__dirname,'../tests/harness/electron-chat-ux-preload.cjs'),contextIsolation:true}});
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error'||/ResizeObserver loop/.test(event.message))errors.push(event.message)});
 const run=code=>win.webContents.executeJavaScript(code,true);
 const assert=(pass,message)=>{if(!pass)throw new Error(message)};
 const waitFor=async(code)=>{for(let i=0;i<60;i++){if(await run(code))return;await pause(100)}throw new Error('Timed out: '+code)};
 const input=async(text)=>run(`(()=>{const el=document.querySelector('textarea[aria-label="Prompt"]');const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(el,${JSON.stringify(text)});el.focus();el.setSelectionRange(el.value.length,el.value.length);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('select',{bubbles:true}));})()`);
 const key=async(name,shift=false)=>run(`document.querySelector('textarea[aria-label="Prompt"]').dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},code:${JSON.stringify(name)},bubbles:true,shiftKey:${shift}}))`);
 const click=async(selector)=>run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.click()})()`);
 const check=async(label)=>{
  await pause(650);
  const result=await run(`(()=>{const main=document.querySelector('.chat-panel'),ta=document.querySelector('textarea[aria-label="Prompt"]'),send=document.querySelector('[aria-label="Send prompt"]');const mr=main.getBoundingClientRect(),tr=ta.getBoundingClientRect(),sr=send.getBoundingClientRect();const style=getComputedStyle(ta);const minTextHeight=parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.lineHeight)*2;return {width:innerWidth,height:innerHeight,chatWidth:mr.width,chatHeight:mr.height,taHeight:tr.height,minTextHeight,sendBottom:sr.bottom,sendRight:sr.right,overflow:document.documentElement.scrollWidth>innerWidth,drawers:document.querySelectorAll('.panel-drawer').length,docked:[...document.querySelectorAll('.docked-panel:not([hidden])')].length}})()`);
  assert(!result.overflow,label+' horizontal overflow');assert(result.chatHeight>120,label+' chat area clipped');assert(result.sendBottom<=result.height+1,label+' send below viewport');assert(result.sendRight<=result.width+1,label+' send outside viewport');assert(result.taHeight>=55,label+' input too short');
  fs.writeFileSync(out+'/'+label+'.png',(await win.webContents.capturePage()).toPNG());console.log(label,JSON.stringify(result));return result;
 };
 try{
  if(process.env.WORKBENCH_UX_URL)await win.loadURL(process.env.WORKBENCH_UX_URL);else await win.loadFile(path.resolve(__dirname,'../frontend/dist/index.html'));await waitFor(`Boolean(document.querySelector('textarea[aria-label="Prompt"]'))`);
  for(const [w,h] of [[720,480],[960,600],[1200,720],[1366,768],[1920,1080]]){win.setContentSize(w,h);await check('empty-'+w);}
  win.setContentSize(720,480);await pause(200);await click('[aria-label="Toggle explorer"]');await waitFor(`Boolean(document.querySelector('[role="dialog"][aria-label="Explorer"]'))`);
  assert(await run(`document.querySelector('[role="dialog"]').contains(document.activeElement)`),'drawer focus');
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await pause(100);
  assert(await run(`document.activeElement.getAttribute('aria-label')==='Toggle explorer'`),'focus return');
  await click('[aria-label="Toggle settings"]');await pause(100);await click('[aria-label="Toggle explorer"]'); // focus containment prevents ordinary focus escape; click still switches
  assert(await run(`document.querySelectorAll('.panel-drawer').length===1`),'multiple drawers');
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await run(`document.querySelector('[aria-label="Toggle explorer"]').focus()`);await click('[aria-label="Toggle explorer"]');await pause(100);
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}))`);
  assert(await run(`document.querySelector('[role="dialog"]').contains(document.activeElement)`),'drawer tab containment');
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await input('Inspect @src/in');await waitFor(`document.querySelectorAll('[role="option"]').length===1`);await key('Enter');await pause(100);
  assert(await run(`document.querySelector('textarea[aria-label="Prompt"]').value==='Inspect @src/input.ts '`),'mention Enter');assert(await run(`window.uxFixture.lastStart()===null`),'mention sent prompt');
  await input('Inspect @src');await waitFor(`document.querySelectorAll('[role="option"]').length===2`);await key('ArrowDown');await key('ArrowUp');await key('Tab');await pause(100);
  assert(await run(`document.querySelector('textarea[aria-label="Prompt"]').value==='Inspect @src/ '`),'folder selection');
  await run(`window.uxFixture.delaySuggestions(400)`);await input('Inspect @src/i');await pause(150);await input('Inspect @source');await pause(650);
  assert(await run(`document.querySelector('[role="option"]').textContent.includes('source files')`),'stale suggestions');
  await input('Inspect @source');await waitFor(`document.querySelectorAll('[role="option"]').length===1`);await key('Tab');await pause(100);
  assert(await run(`document.querySelector('textarea[aria-label="Prompt"]').value.includes('@"source files/試験.ts"')`),'quoted mention');
  await input('Inspect @src');await waitFor(`document.querySelectorAll('[role="option"]').length===2`);await key('Escape');await pause(100);assert(await run(`!document.querySelector('[role="listbox"]')`),'Escape suggestions');
  await input('Inspect @src');await key('Enter',true);assert(await run(`window.uxFixture.lastStart()===null`),'Shift Enter sent');
  await run(`document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`);await key('Enter');assert(await run(`window.uxFixture.lastStart()===null`),'IME Enter sent');await run(`document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`);
  for(const mode of ['Work','Agent','Chat']){await run(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(mode)}).click()`);await input(`Inspect ${mode} @src/in`);await waitFor(`document.querySelectorAll('[role="option"]').length===1`);await key('Escape');}
  await run(`window.uxFixture.workspace(null)`);await input('Inspect @src');await pause(150);assert(await run(`!document.querySelector('[role="listbox"]')`),'suggestions without workspace');
  await run(`window.uxFixture.workspace({root:'/test/workspace',registeredAt:'2026-10-12T00:00:00Z'})`);
  await input('Inspect @src/input.ts ');await run(`window.uxFixture.hold(true)`);await click('[aria-label="Send prompt"]');await pause(250);
  assert(await run(`window.uxFixture.lastStart()?.workspaceReferences?.[0]?.path==='src/input.ts'`),'structured source missing');
  for(const [w,h] of [[720,480],[960,600],[1200,720],[1366,768],[1920,1080]]){win.setContentSize(w,h);await check('active-'+w)}
  await run(`window.uxFixture.finish()`);await pause(100);
  for(const [w,h] of [[720,480],[960,600],[1200,720],[1366,768],[1920,1080]]){win.setContentSize(w,h);await check('long-'+w)}
  await run(`window.uxFixture.title('A model title for this chat')`);await pause(50);assert(await run(`document.querySelector('h1').textContent==='A model title for this chat'`),'title event not reflected');
  win.webContents.setZoomFactor(1.25);win.setContentSize(1200,720);await check('zoom-125');win.webContents.setZoomFactor(1);
  win.setFullScreen(true);await pause(400);await check('fullscreen');win.setFullScreen(false);
  assert(!errors.length,'UI errors: '+errors.join('\n'));console.log('UI checks passed. Screenshots: '+out);win.destroy();app.quit();
 }catch(error){console.error(error);fs.writeFileSync(out+'/failure.png',(await win.webContents.capturePage()).toPNG());win.destroy();app.exit(1)}
});
