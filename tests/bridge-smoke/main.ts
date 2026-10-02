// Exercise the production preload and registered handlers in a real BrowserWindow.
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { initBackend, type BackendInstance } from "../../backend/src/main/index.js";
import { ModelGateway } from "../../backend/src/main/gateway/model-gateway.js";
import { closeDb } from "../../backend/src/main/persistence/db.js";
import { RAGDatabase } from "../../ai/rag/db.js";
import { loadProfile, registryForRelay } from "../config.js";
import { ModelRelay } from "../harness/model-relay.js";
import { completion } from "../harness/mock-model.js";
import { createSandbox, destroySandbox } from "../harness/sandbox.js";

const root = process.cwd();
const box = createSandbox(path.join(root, "tests/.runtime/bridge"));
app.setPath("userData", path.join(box.data, "electron"));
app.disableHardwareAcceleration();
let window: BrowserWindow | undefined;
let manager: BackendInstance | undefined;
let relay: ModelRelay | undefined;
let finishing = false;
async function finish(code: number, result: unknown): Promise<void> {
  if (finishing) return;
  finishing = true;
  clearTimeout(timeout);
  mkdirSync(path.join(root, "tests/.runtime"), { recursive: true });
  writeFileSync(path.join(root, "tests/.runtime/bridge-smoke.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  window?.destroy();
  await relay?.close();
  RAGDatabase.close();
  closeDb();
  destroySandbox(box);
  app.exit(code);
}
const timeout = setTimeout(() => void finish(2, { pass: false, error: "Native bridge smoke timed out" }), 30000);
app.whenReady().then(async () => {
  const profile = loadProfile(path.join(root, "tests/profiles/local.example.json"));
  relay = new ModelRelay(profile, "mock", () => {}, (_route, body) => {
    const messages = body.messages as Array<{ role: string; content: string }> | undefined;
    if (messages?.some((m) => m.role === "system" && m.content.includes("Semantic Intent Orchestrator"))) return completion(body, JSON.stringify({ intentType: "general_qa", taskType: "draft", driverModel: "draft-qwen3", primaryGoal: "Answer greeting", isActionable: false, chatResponseOnly: true, workspaceMutationRequested: false, targetFiles: [], protectedPaths: [], restrictMutationsToTargets: false, expectedDeliverables: [], reason: "Bridge transport calibration" }));
    return completion(body, "BRIDGE_SMOKE_OK");
  });
  const origin = await relay.start();
  const registry = registryForRelay(profile, origin);
  const modelsPath = path.join(box.root, "config/models.json");
  writeFileSync(modelsPath, JSON.stringify({ models: registry }));
  manager = initBackend(ipcMain, (event) => window?.webContents.send("workbench:runEvent", event), { dataDir: box.data, modelsPath, schemaPath: path.join(root, "backend/src/main/persistence/schema.sql"), embeddingConfig: { ...profile.target.embedding, baseUrl: `${origin}/embedding/v1` } }, undefined, new ModelGateway(undefined, registry));
  await manager.ragService.init();
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, "tests/.runtime/build/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadURL("data:text/html," + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'"><title>Behavioral bridge smoke</title>'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    function assert(ok, message) { if (!ok) throw new Error(message); }
    assert(typeof require === 'undefined' && typeof process === 'undefined', 'Renderer exposes Node');
    const b = window.workbench; assert(b && typeof b.startRun === 'function', 'Preload bridge missing');
    const events = []; const unsubscribe = b.onRunEvent(e => events.push(e));
    const chat = await b.createChat({title:'Native bridge smoke'});
    const attachment = await b.registerAttachment({chatId:chat.chatId,filename:'hello.txt',mediaType:'text/plain',sizeBytes:5,base64OrBuffer:'aGVsbG8='});
    const token = attachment.attachment?.attachmentId;
    assert(typeof token === 'string', 'Attachment registration contract');
    await b.sendMessage(chat.chatId,'user','Say hello',[token]);
    const run = await b.startRun({chatId:chat.chatId,runId:attachment.runId,userText:'Say hello',attachmentTokens:[token],groundingEnabled:false});
    const started = Date.now();
    while (!events.some(e => e.runId === run.runId && e.type === 'run_state' && ['completed','failed','cancelled'].includes(e.state))) {
      if (Date.now()-started > 15000) throw new Error('Terminal event not received');
      await new Promise(r => setTimeout(r,20));
    }
    assert(events.some(e => e.runId === run.runId && e.type === 'run_state' && e.state === 'completed'), 'Native run did not complete');
    const {messages} = await b.getMessages(chat.chatId);
    assert(messages.filter(m => m.role === 'user').length === 1, 'Duplicate/missing persisted user message');
    assert(messages.some(m => m.role === 'assistant' && m.content.includes('BRIDGE_SMOKE_OK')), 'Assistant message missing');
    unsubscribe(); const count = events.length;
    await b.cancelRun({runId:run.runId}); await new Promise(r => setTimeout(r,100));
    assert(events.length === count, 'Event unsubscribe failed');
    return {pass:true, nativeElectron:true, realModels:false, checks:['preload context isolation','attachment serialization','chat persistence','startRun','terminal event subscription','assistant persistence','unsubscribe']};
  })()`);
  await finish(0, result);
}).catch((error) => void finish(2, { pass: false, error: String(error) }));
