// Isolated Electron interface checks. The bridge is a fixture; draft storage is real IndexedDB.
if (!process.versions.electron) {
 const { spawnSync } = require('node:child_process');
 const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
 const result = spawnSync(require('electron'), [__filename], { stdio: 'inherit', env: environment });
 process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-continuity-'));
app.setPath('userData', path.join(out, 'profile'));
const a = randomUUID(), b = randomUUID(), runA = randomUUID(), runB = randomUUID(), userA = randomUUID(), userB = randomUUID();
const chats = [{ id: a, title: 'Source task', updated_at: new Date().toISOString() }, { id: b, title: 'Interrupted task', updated_at: new Date().toISOString() }];
const messages = new Map([[a, [{ id: userA, role: 'user', content: 'Original request', run_id: runA }, { id: randomUUID(), role: 'assistant', content: 'Original saved answer', run_id: runA }]], [b, [{ id: userB, role: 'user', content: 'Create a report', run_id: runB }]]]);
const snapshots = new Map([[a, { runId: runA, chatId: a, mode: 'chat', state: 'completed', engineVersion: 'fixture', progress: [], artifacts: [], metrics: {} }], [b, { runId: runB, chatId: b, mode: 'work', state: 'partial', engineVersion: 'fixture', progress: [], artifacts: [], metrics: {}, recovery: { canResume: true, largerGenerationAllowance: false, sourceMessageId: userB, reason: 'The app stopped during review.', completed: ['Read selected sources'], remaining: ['Check the report'] } }]]);
const settings = new Map([['lastChatId', a]]), failures = new Set(), starts = [], resumes = [], uploads = [];
let win;
const emit = event => win.webContents.send('continuity:Run', event);
const complete = (chatId, runId) => {
 const messageId = randomUUID();
 messages.get(chatId).push({ id: messageId, role: 'assistant', content: 'New saved answer', run_id: runId });
 emit({ type: 'assistant_message', runId, messageId, modelId: 'primary-model', text: 'New saved answer' });
 snapshots.get(chatId).state = 'completed'; delete snapshots.get(chatId).recovery;
 emit({ type: 'run_state', runId, state: 'completed' });
};
ipcMain.handle('continuity:fail', (_event, method, value) => { if (value) failures.add(method); else failures.delete(method); });
ipcMain.handle('continuity:state', () => ({ chats, starts, resumes, uploads, original: messages.get(a), sourceChatId: a }));
ipcMain.handle('continuity:call', async (_event, method, args) => {
 if (failures.has(method)) throw new Error('Fixture storage or connection failure');
 switch (method) {
 case 'getOnboardingStatus': return { completed: true };
 case 'getChatHistory': return { chats };
 case 'getSetting': return { value: settings.get(args[0]) ?? null };
 case 'setSetting': settings.set(args[0], args[1]); return;
 case 'getMessages': return { messages: messages.get(args[0]) ?? [] };
 case 'getRunSnapshot': return args[0].chatId ? snapshots.get(args[0].chatId) : [...snapshots.values()].find(value => value.runId === args[0].runId);
 case 'getRunHistory': return [...snapshots.values()];
 case 'getCurrentWorkspace': case 'getExecutionCapabilities': case 'getVerificationReport': return null;
 case 'getHealth': case 'kbListDocs': return [];
 case 'kbStats': return { docCount: 0, chunkCount: 0 };
 case 'notifyResponse': return { notified: false };
 case 'createChat': { const id = randomUUID(); chats.unshift({ id, title: args[0]?.title ?? 'New chat', updated_at: new Date().toISOString() }); messages.set(id, []); return { chatId: id }; }
 case 'registerAttachment': { const input = args[0]; uploads.push(input); return { runId: randomUUID(), attachment: { attachmentId: randomUUID(), filename: input.filename, mediaType: input.mediaType, sizeBytes: input.sizeBytes, relativePath: 'fixture/input' } }; }
 case 'sendMessage': { const [id, role, content] = args, messageId = randomUUID(); messages.get(id).push({ id: messageId, role, content }); return { messageId, seq: messages.get(id).length - 1 }; }
 case 'startRun': { const input = args[0]; starts.push(input); messages.get(input.chatId).find(message => message.id === input.userMessageId).run_id = input.runId;
  snapshots.set(input.chatId, { runId: input.runId, chatId: input.chatId, mode: input.mode, state: 'acting', engineVersion: 'fixture', progress: [], artifacts: [], metrics: {} });
  setTimeout(() => { emit({ type: 'run_registered', runId: input.runId, chatId: input.chatId, mode: input.mode }); emit({ type: 'run_state', runId: input.runId, state: 'acting' }); setTimeout(() => complete(input.chatId, input.runId), 100); }, 10);
  return { runId: input.runId }; }
 case 'resumeRun': { const input = args[0]; resumes.push(input); const snap = [...snapshots.values()].find(value => value.runId === input.runId); snap.state = 'acting';
  setTimeout(() => { emit({ type: 'run_state', runId: input.runId, state: 'acting' }); setTimeout(() => complete(snap.chatId, input.runId), 100); }, 10); return { runId: input.runId }; }
 case 'createMessageAttempt': { const input = args[0], id = randomUUID();
  const source = [...messages.entries()].find(([, rows]) => rows.some(row => row.id === input.messageId));
  const position = source[1].findIndex(row => row.id === input.messageId);
  const title = 'Revised task'; chats.unshift({ id, title, updated_at: new Date().toISOString(), forkedFrom: { chatId: source[0], messageId: input.messageId } });
  messages.set(id, source[1].slice(0, position).map(row => ({ ...row, id: randomUUID() })));
  return { chatId: id, title, sourceChatId: source[0], sourceMessageId: input.messageId, text: input.content, mode: 'chat', workspaceRoot: null, files: [{ filename: 'saved-source.txt', mediaType: 'text/plain', base64: Buffer.from('saved source bytes').toString('base64') }] }; }
 case 'renameChat': chats.find(chat => chat.id === args[0]).title = args[1]; return;
 case 'archiveChat': return;
 default: throw new Error('Unexpected fixture method: ' + method);
 }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
 win = new BrowserWindow({ show: false, width: 1366, height: 768, useContentSize: true, webPreferences: { preload: path.join(root, 'tests/harness/electron-chat-continuity-preload.cjs'), contextIsolation: true } });
 const run = code => win.webContents.executeJavaScript(code, true);
 const assert = (pass, label) => { if (!pass) throw new Error(label); };
 const wait = async code => { for (let i=0; i<100; i++) { if (await run(code)) return; await pause(50); } throw new Error('Timed out: ' + code); };
 const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
 const button = text => run(`Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim()===${JSON.stringify(text)}).click()`);
 const input = (value, selector = 'textarea[aria-label="Prompt"]') => run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const saved = () => wait(`document.body.innerText.includes('Draft saved on this computer')`);
 const select = async title => { await click(`[title="${title}"]`); await wait(`document.querySelector('h1').textContent===${JSON.stringify(title)} && !document.querySelector('textarea[aria-label="Prompt"]').disabled`); };
 try {
  await win.loadFile(path.join(root, 'frontend/dist/index.html'));
  await wait(`document.querySelector('h1')?.textContent==='Source task' && !document.querySelector('textarea[aria-label="Prompt"]').disabled`);
  assert(await run(`document.querySelector('[title="Interrupted task"]').textContent.includes('Needs review')`), 'Interrupted work is not visible in the chat list');
  await input('draft for source task');
  await run(`(()=>{const el=document.querySelector('input[type=file]');const data=new DataTransfer();data.items.add(new File(['retained attachment bytes'],'draft-input.txt',{type:'text/plain'}));el.files=data.files;el.dispatchEvent(new Event('change',{bubbles:true}));})()`); await saved();
  await run(`window.continuityFixture.fail('createChat',true)`); await click('[title="New conversation"]');
  await wait(`document.body.innerText.includes('Saved chats need attention.')`);
  assert(await run(`document.querySelector('h1').textContent==='Source task' && document.querySelector('textarea[aria-label="Prompt"]').value==='draft for source task' && document.body.innerText.includes('draft-input.txt')`), 'Failed New chat changed the current task');
  await run(`window.continuityFixture.fail('createChat',false)`); await button('Retry saved chats');
  await wait(`!document.body.innerText.includes('Saved chats need attention.')`);
  await click('[title="New conversation"]'); await wait(`document.querySelector('h1').textContent==='New chat' && !document.querySelector('textarea[aria-label="Prompt"]').disabled`);
  assert(await run(`document.querySelector('textarea[aria-label="Prompt"]').value==='' && !document.body.innerText.includes('draft-input.txt')`), 'New chat reused another draft or attachment');
  await input('draft for new chat'); await saved();
  await select('Source task'); await wait(`document.querySelector('textarea[aria-label="Prompt"]').value==='draft for source task'`);
  assert(await run(`document.body.innerText.includes('draft-input.txt')`), 'Chat attachment not restored');
  await input('fast typed source draft'); await click('[title="New chat"]');
  await wait(`document.querySelector('textarea[aria-label="Prompt"]').value==='draft for new chat'`);
  await select('Source task'); await wait(`document.querySelector('textarea[aria-label="Prompt"]').value==='fast typed source draft'`);
  await run(`document.querySelector('[title="Source task"]').parentElement.querySelector('[aria-label="Chat options"]').click()`); await wait(`!!document.querySelector('[role=menu]')`); await button('Pin');
  win.reload(); await wait(`document.querySelector('h1')?.textContent==='Source task' && document.querySelector('textarea[aria-label="Prompt"]')?.value==='fast typed source draft'`); await saved();
  assert(await run(`document.body.innerText.includes('draft-input.txt')`), 'Restart lost attachment bytes');
  await run(`document.querySelector('[title="Source task"]').parentElement.querySelector('[aria-label="Chat options"]').click()`); await wait(`!!document.querySelector('[role=menu]')`);
  assert(await run(`document.querySelector('[role=menu]').innerText.includes('Unpin')`), 'Restart lost pin'); await button('Unpin');
  console.log('Passed: chat drafts, attachment restoration, pins, and startup view');
  // A failed IndexedDB write must remain visible and retryable.
  await run(`window.originalDraftPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new Error('Draft disk failure')};undefined`);
  await input('unsaved text after disk failure'); await wait(`document.body.innerText.includes('Draft is not saved.')`);
  await run(`IDBObjectStore.prototype.put=window.originalDraftPut;undefined`); await button('Retry draft save'); await saved();
  // A failed run start must retain both the prompt and its attachment.
  await run(`window.continuityFixture.fail('startRun',true)`); await click('[aria-label="Send prompt"]'); await wait(`document.body.innerText.includes('send_failed') && !document.querySelector('textarea[aria-label="Prompt"]').disabled`);
  assert(await run(`document.querySelector('textarea[aria-label="Prompt"]').value==='unsaved text after disk failure' && document.body.innerText.includes('draft-input.txt')`), 'Failed send lost draft');
  assert(uploads.at(-1).base64OrBuffer===Buffer.from('retained attachment bytes').toString('base64'), 'Restored attachment bytes changed');
  await run(`window.continuityFixture.fail('startRun',false)`);
  await run(`window.continuityFixture.fail('getMessages',true)`); await click('[title="Interrupted task"]'); await wait(`document.body.innerText.includes('Saved chats need attention.')`);
  const before = starts.length; await click('[aria-label="Send prompt"]'); await pause(100); assert(starts.length===before, 'Storage error started an unsaved run');
  await run(`window.continuityFixture.fail('getMessages',false)`); await button('Retry saved chats'); await wait(`!!document.querySelector('[aria-label="Task recovery"]')`);
  console.log('Passed: failed draft save, failed send, and failed history read');
  win.reload(); await wait(`document.querySelector('h1')?.textContent==='Interrupted task' && !!document.querySelector('[aria-label="Task recovery"]')`);
  win.setContentSize(720,480); await pause(150);
  assert(await run(`document.querySelector('[aria-label="Send prompt"]').getBoundingClientRect().bottom<=innerHeight+1 && document.documentElement.scrollWidth<=innerWidth`), 'Recovery makes small-window controls unreachable');
  fs.writeFileSync(path.join(out,'recovery-small.png'),(await win.webContents.capturePage()).toPNG());
  win.setContentSize(1366,768); await pause(150);
  await run(`window.continuityFixture.fail('resumeRun',true)`); await button('Resume task'); await wait(`document.body.innerText.includes('resume_failed')`);
  assert(await run(`!!document.querySelector('[aria-label="Task recovery"]')`), 'Failed resume hid recovery');
  await run(`window.continuityFixture.fail('resumeRun',false)`); await button('Resume task'); await wait(`!document.querySelector('[aria-label="Task recovery"]') && !document.querySelector('textarea[aria-label="Prompt"]').disabled`);
  assert(resumes.length===1 && resumes[0].runId===runB, 'Resume created or selected the wrong run');
  console.log('Passed: recovery after restart, failed Resume, and same-run continuation');
  await select('Source task'); await click('[aria-label="Edit and rerun"]'); await input('Revised request with copied inputs','textarea[aria-label="Revised request"]');
  await run(`window.continuityFixture.fail('createMessageAttempt',true)`); await button('Edit and rerun');
  await wait(`document.body.innerText.includes('new_attempt_failed') && !!document.querySelector('textarea[aria-label="Revised request"]')`);
  assert(messages.get(a)[0].content==='Original request', 'Failed edit changed original request');
  await run(`window.continuityFixture.fail('createMessageAttempt',false)`);
  await run(`document.querySelector('textarea[aria-label="Revised request"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}))`);
  await wait(`document.querySelector('h1').textContent==='Revised task' && !document.querySelector('textarea[aria-label="Prompt"]').disabled`);
  assert(starts.at(-1).chatId!==a && starts.at(-1).userText==='Revised request with copied inputs' && starts.at(-1).attachmentTokens.length===1, 'Edit did not start an independent attempt with inputs');
  assert(messages.get(a)[0].content==='Original request', 'Edit changed original request');
  assert(await run(`document.body.innerText.includes('View original')`), 'Attempt lineage missing');
  await button('View original'); await wait(`document.querySelector('h1').textContent==='Source task' && document.querySelector('textarea[aria-label="Prompt"]').value==='unsaved text after disk failure'`);
  console.log('Passed: Edit and rerun, linked original, and retained original draft');
  settings.set('lastChatId',null); win.reload();
  await wait(`document.querySelector('h1')?.textContent==='New chat' && !document.querySelector('textarea[aria-label="Prompt"]').disabled`);
  await input('Initial unsent draft'); await saved(); await click('[title="New conversation"]');
  await wait(`!!document.querySelector('[title="Unsent draft"]') && document.querySelector('textarea[aria-label="Prompt"]').value==='' && !document.querySelector('textarea[aria-label="Prompt"]').disabled`);
  await select('Unsent draft'); await wait(`document.querySelector('textarea[aria-label="Prompt"]').value==='Initial unsent draft'`);
  console.log('Passed: an initial unsent draft stays visible after New chat');
  fs.writeFileSync(path.join(out,'continuity.png'),(await win.webContents.capturePage()).toPNG());
  console.log('Continuity checks passed. Evidence: '+out);
  win.destroy(); app.quit();
 } catch(error) { console.error(error); fs.writeFileSync(path.join(out,'failure.png'),(await win.webContents.capturePage()).toPNG()); console.error('Evidence: '+out); win.destroy(); app.exit(1); }
});
