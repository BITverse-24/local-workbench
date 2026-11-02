// Independent Flow D evaluation. The project is served read-only; browser data
// and the Electron profile live in a temporary directory outside the project.
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env });
  process.exit(child.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const projectArg = process.argv[2], baselineArg = process.argv[3];
if (!projectArg || !baselineArg) throw new Error('Provide an evaluation workspace and a pristine baseline workspace.');
const project = fs.realpathSync(projectArg), baseline = fs.realpathSync(baselineArg);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-d-browser-'));
app.setPath('userData', path.join(profile, 'profile'));
app.disableHardwareAcceleration();
const outcome = { workspace: project, baseline, checks: [], consoleErrors: [] };
const check = async (name, fn) => {
  try { await fn(); outcome.checks.push({ name, passed: true }); }
  catch (error) { outcome.checks.push({ name, passed: false, error: String(error?.message ?? error) }); }
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function files(root, directory = '') {
  const result = {};
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (entry.name === '.harness_backups') continue;
    const name = path.join(directory, entry.name), absolute = path.join(root, name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not accepted: ${name}`);
    if (entry.isDirectory()) Object.assign(result, files(root, name));
    else if (entry.isFile()) result[name.split(path.sep).join('/')] = digest(fs.readFileSync(absolute));
    else throw new Error(`Unsupported project entry: ${name}`);
  }
  return result;
}
function serverFor(root) {
  return createServer((request, response) => {
    try {
      if (request.method !== 'GET') { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/__evaluation_seed__') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end('<!doctype html><title>Evaluation seed</title>'); return; }
      const name = pathname === '/' ? '/index.html' : pathname;
      const target = path.resolve(root, '.' + name), real = fs.realpathSync(target);
      if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error('Outside evaluation workspace');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(real)] ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(real).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
}
async function main() {
  await app.whenReady();
  await check('Protected project files and existing tests remain unchanged', () => {
    const original = files(baseline), candidate = files(project);
    const mutable = new Set(['src/storage.js', 'src/work-orders.js']);
    const changed = [...new Set([...Object.keys(original), ...Object.keys(candidate)])].filter(file => original[file] !== candidate[file]);
    outcome.changedFiles = changed;
    assert.deepEqual(changed.filter(file => !mutable.has(file)), []);
  });
  await check('Existing full test suite', () => {
    const test = spawnSync(process.execPath, ['--test'], { cwd: project, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000 });
    outcome.projectTests = { status: test.status, signal: test.signal, stdout: test.stdout?.slice(-10000), stderr: test.stderr?.slice(-10000), error: test.error?.message };
    assert.equal(test.status, 0, 'Existing project tests did not pass');
  });
  const server = serverFor(project);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    try { callback({ cancel: new URL(details.url).origin !== url }); }
    catch { callback({ cancel: true }); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', details => {
    if (details.level === 'error' || /\bUncaught\b/.test(details.message)) outcome.consoleErrors.push(details.message);
  });
  const run = source => win.webContents.executeJavaScript(source, true);
  const open = async saved => {
    await win.loadURL(`${url}/__evaluation_seed__`);
    await run(`localStorage.clear(); ${saved === null ? '' : `localStorage.setItem('fieldops.workOrders', ${JSON.stringify(saved)});`}`);
    const errors = outcome.consoleErrors.length;
    await win.loadURL(`${url}/index.html`);
    await run(`new Promise(resolve => { if (document.readyState === 'complete') setTimeout(resolve,100); else window.addEventListener('load',()=>setTimeout(resolve,100),{once:true}); })`);
    assert.deepEqual(outcome.consoleErrors.slice(errors), [], 'The app reported a startup error');
  };
  try {
    await check('Startup, rendered controls, and module exports', async () => {
      await open(null);
      const state = await run(`(async()=>({title:document.querySelector('h1')?.textContent,nodeExposed:typeof process !== 'undefined' || typeof require !== 'undefined',count:document.querySelector('#result-count')?.textContent,cards:document.querySelectorAll('.order-card').length,search:!!document.querySelector('#search'),status:!!document.querySelector('#status-filter'),storage:Object.keys(await import('/src/storage.js')),orders:Object.keys(await import('/src/work-orders.js'))}))()`);
      assert.equal(state.title, 'Work orders'); assert.equal(state.nodeExposed, false); assert.equal(state.count, 'Showing 5 of 5 work orders'); assert.equal(state.cards, 5); assert.ok(state.search && state.status);
      for (const name of ['STORAGE_KEY', 'loadWorkOrders', 'saveWorkOrders']) assert.ok(state.storage.includes(name), `Missing storage export ${name}`);
      for (const name of ['filterWorkOrders', 'changeWorkOrderStatus']) assert.ok(state.orders.includes(name), `Missing work-order export ${name}`);
    });
    await check('Search and status filters work together', async () => {
      await open(null);
      const result = await run(`(()=>{const search=document.querySelector('#search'),filter=document.querySelector('#status-filter');search.value='nOrTh';search.dispatchEvent(new Event('input',{bubbles:true}));filter.value='open';filter.dispatchEvent(new Event('change',{bubbles:true}));const open=[...document.querySelectorAll('.order-id')].map(x=>x.textContent);filter.value='closed';filter.dispatchEvent(new Event('change',{bubbles:true}));const closed=[...document.querySelectorAll('.order-id')].map(x=>x.textContent);search.value='not-a-work-order';search.dispatchEvent(new Event('input',{bubbles:true}));return {open,closed,count:document.querySelector('#result-count').textContent,empty:!document.querySelector('#empty-state').hidden};})()`);
      assert.deepEqual(result.open, ['WO-2481']); assert.deepEqual(result.closed, ['WO-2468']); assert.equal(result.count, 'Showing 0 of 5 work orders'); assert.equal(result.empty, true);
    });
    await check('Status changes persist after reload', async () => {
      await open(null);
      const saved = await run(`(()=>{const control=document.querySelector('select[data-order-id="WO-2481"]');control.value='closed';control.dispatchEvent(new Event('change',{bubbles:true}));return JSON.parse(localStorage.getItem('fieldops.workOrders'));})()`);
      assert.equal(saved.find(order => order.id === 'WO-2481')?.status, 'closed'); assert.equal(saved.length, 5);
      const errors = outcome.consoleErrors.length; await win.loadURL(`${url}/index.html`);
      await run(`new Promise(resolve=>setTimeout(resolve,100))`);
      assert.deepEqual(outcome.consoleErrors.slice(errors), []);
      assert.equal(await run(`document.querySelector('select[data-order-id="WO-2481"]')?.value`), 'closed');
    });
    for (const [name, invalid] of [['malformed JSON', '{broken'], ['wrong shape', '{"orders":[]}'], ['invalid array entry', '[null]']]) {
      await check(`Invalid saved data: ${name}`, async () => {
        await open(invalid);
        const result = await run(`({count:document.querySelector('#result-count')?.textContent,cards:document.querySelectorAll('.order-card').length})`);
        assert.deepEqual(result, { count: 'Showing 5 of 5 work orders', cards: 5 });
      });
    }
    await check('Valid saved work orders are restored', async () => {
      const saved = [{ id: 'WO-SAVED', title: 'Saved task', site: 'Test site', priority: 'Low', status: 'closed' }];
      await open(JSON.stringify(saved));
      assert.deepEqual(await run(`({ids:[...document.querySelectorAll('.order-id')].map(x=>x.textContent),status:document.querySelector('.order-status')?.value,count:document.querySelector('#result-count')?.textContent})`), { ids: ['WO-SAVED'], status: 'closed', count: 'Showing 1 of 1 work orders' });
    });
  } finally { win.destroy(); await new Promise(resolve => server.close(resolve)); }
  outcome.passed = outcome.checks.every(item => item.passed);
  process.stdout.write(JSON.stringify(outcome, null, 2) + '\n');
  app.exit(outcome.passed ? 0 : 1);
}
main().catch(error => { process.stderr.write(String(error?.stack ?? error) + '\n'); app.exit(1); });
