import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { closeDb, getDb, initDb } from '../src/main/persistence/db.js';
import { createChat, getChat, listChats } from '../src/main/persistence/chats.js';
import { addMessage, editMessage, listMessages } from '../src/main/persistence/messages.js';
import { createMessageAttempt } from '../src/main/run/message-attempt.js';
import { handleSendMessage, registerChatHandlers } from '../src/main/ipc/handlers.js';
import { RunManager } from '../src/main/run/manager.js';
import { absoluteDataPath, artifactRef, createRunDirectories, setDataDir, writeRunFile } from '../src/main/run/filesystem.js';
import { createRun, getState, transition } from '../src/main/run/store.js';
import { persistRunContract } from '../src/main/run/contract.js';
import { configureExecutionLedger, getExecutionLedger, initializeExecutionLedger, reconcileInterruptedExecutions, recordExecutionToolStarted, updateExecutionLedgerState } from '../src/main/run/execution-ledger.js';
import { recoverInterruptedModeRuns } from '../src/main/run/recovery.js';
import { createConfirmation } from '../src/main/confirmation/store.js';
import { testModelGateway } from './helpers/test-model-registry.js';
import { HarnessManager } from '../src/main/harness/harness-manager.js';
import type { ExecutionMode, RunContract } from '../src/shared/contracts.js';

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'chat-continuity-'))); setDataDir(dir); initDb(path.join(dir, 'db.sqlite')); });
afterEach(() => { vi.restoreAllMocks(); closeDb(); rmSync(dir, { recursive: true, force: true }); });
const terminal = (id: string) => vi.waitFor(() => expect(['completed', 'partial', 'failed', 'cancelled']).toContain(getState(id)));
function manager() {
  const gateway = testModelGateway();
  vi.spyOn(gateway, 'chatWithTools').mockResolvedValue({ ok: true, value: { content: 'Saved answer.', tool_calls: [], finishReason: 'stop' } } as any);
  vi.spyOn(gateway, 'generateChatTitle').mockResolvedValue('Saved request');
  return { manager: new RunManager(gateway), gateway };
}
async function original() {
  const setup = manager(), chatId = createChat('Original task');
  addMessage({ chat_id: chatId, role: 'user', content: 'Earlier context' });
  addMessage({ chat_id: chatId, role: 'assistant', content: 'Earlier answer' });
  const bytes = Buffer.from('original source bytes\n');
  const attachment = setup.manager.registerAttachment({ chatId, filename: 'notes.txt', mediaType: 'text/plain', sizeBytes: bytes.length, base64OrBuffer: bytes });
  const request = handleSendMessage({ chatId, role: 'user', content: 'Inspect the attached notes', attachmentIds: [attachment.attachment.attachmentId] });
  const { runId } = await setup.manager.start({ chatId, userMessageId: request.messageId, userText: 'Inspect the attached notes', mode: 'chat', attachmentTokens: [attachment.attachment.attachmentId] });
  await terminal(runId);
  return { ...setup, chatId, runId, messageId: request.messageId, bytes };
}
function savedPartial(mode: ExecutionMode = 'work') {
  const chatId = createChat('Interrupted task'), runId = createRun(chatId, 'Create report.md');
  createRunDirectories(runId);
  const message = addMessage({ chat_id: chatId, run_id: runId, role: 'user', content: 'Create report.md' });
  const contract: RunContract = { schemaVersion: 1, runId, createdAt: new Date().toISOString(), objective: 'Create report.md', resolution: { status: 'resolved' },
    routing: { intentType: 'document_drafting', taskType: 'draft', driverModel: 'primary-model', actionable: true }, response: { required: true, chatOnly: false },
    workspace: { requested: false, operations: [] }, deliverables: [{ id: 'report', type: 'md', filename: 'report.md' }],
    constraints: { protectedPaths: [], restrictMutationsToTargets: false, userConstraints: [] }, acceptance: { validateWrittenCode: false, validatedPythonDeliverables: [], artifactChecks: [] } };
  persistRunContract(contract); initializeExecutionLedger(contract); configureExecutionLedger(runId, { mode, modelId: 'primary-model', groundingEnabled: false });
  getDb().prepare('INSERT INTO run_mode_details(run_id,mode,engine_version,metrics_json) VALUES (?,?,?,?)').run(runId, mode, 'fixture', JSON.stringify({ originalRequest: 'Create report.md' }));
  updateExecutionLedgerState(runId, 'partial'); transition(runId, 'partial');
  return { chatId, runId, messageId: message.id };
}

describe('immutable message attempts', () => {
  it('keeps the original folder listing as read-only evidence when an attempt is forked', async () => {
    const { manager: runtime, gateway } = manager();
    const root = path.join(dir, 'project'); mkdirSync(root); mkdirSync(path.join(root, 'source'));
    writeFileSync(path.join(root, 'source', 'original.txt'), 'PRIVATE_CONTENT_NOT_SELECTED');
    const harness = new HarnessManager(); runtime.setHarness(harness); const workspace = harness.registerWorkspace(root);
    const chatId = createChat('Folder selection'), text = 'List @source/';
    const request = handleSendMessage({ chatId, role: 'user', content: text });
    const { runId } = await runtime.start({ chatId, userMessageId: request.messageId, userText: text, mode: 'chat', workspaceIdentity: workspace, workspaceReferences: [{ path: 'source', kind: 'directory' }] });
    await terminal(runId);
    writeFileSync(path.join(root, 'source', 'later.txt'), 'LATER_CONTENT');
    const attempt = createMessageAttempt(request.messageId, 'Summarize the paths in @source/');
    expect(attempt.files).toEqual([]);
    const revised = handleSendMessage({ chatId: attempt.chatId, role: 'user', content: attempt.text });
    const next = await runtime.start({ chatId: attempt.chatId, userMessageId: revised.messageId, userText: attempt.text, mode: 'chat', workspaceReferences: [] });
    await terminal(next.runId);
    const evidence = String(vi.mocked(gateway.chatWithTools).mock.calls.at(-1)?.[1].at(-1)?.content);
    expect(evidence).toContain('source/original.txt'); expect(evidence).not.toContain('later.txt');
    expect(evidence).not.toContain('PRIVATE_CONTENT_NOT_SELECTED');
    expect(vi.mocked(gateway.chatWithTools).mock.calls.at(-1)?.[2]).toEqual([]);
  });
  it('forks only the earlier context, copies verified bytes, and creates a new independently bound run', async () => {
    const source = await original();
    addMessage({ chat_id: source.chatId, role: 'user', content: 'Later request must not be copied' });
    const before = listMessages(source.chatId);
    const attempt = createMessageAttempt(source.messageId, 'Summarize the attached notes');
    expect(attempt.chatId).not.toBe(source.chatId);
    expect(attempt.mode).toBe('chat');
    expect(Buffer.from(attempt.files[0].base64, 'base64')).toEqual(source.bytes);
    expect(listMessages(attempt.chatId).map(message => message.content)).toEqual(['Earlier context', 'Earlier answer']);
    expect(listMessages(source.chatId)).toEqual(before);
    expect(listChats().find(chat => chat.id === attempt.chatId)?.forkedFrom).toMatchObject({ chatId: source.chatId, messageId: source.messageId });
    expect(JSON.parse(getChat(attempt.chatId)!.metadata).forkedFrom.messageId).toBe(source.messageId);
    expect(getDb().prepare('SELECT COUNT(*) as count FROM runs WHERE chat_id=?').get(attempt.chatId)).toEqual({ count: 0 });
    const file = attempt.files[0];
    const copied = source.manager.registerAttachment({ chatId: attempt.chatId, filename: file.filename, mediaType: file.mediaType, sizeBytes: source.bytes.length, base64OrBuffer: file.base64 });
    const request = handleSendMessage({ chatId: attempt.chatId, role: 'user', content: attempt.text, attachmentIds: [copied.attachment.attachmentId] });
    const { runId } = await source.manager.start({ chatId: attempt.chatId, userMessageId: request.messageId, userText: attempt.text, mode: 'chat', attachmentTokens: [copied.attachment.attachmentId] });
    await terminal(runId);
    expect(runId).not.toBe(source.runId);
    expect(listMessages(attempt.chatId).find(message => message.id === request.messageId)?.run_id).toBe(runId);
    expect(listMessages(source.chatId)).toEqual(before);
    expect(() => editMessage(source.messageId, 'Overwritten request')).toThrow(/Edit and rerun/);
  });
  it('rejects changed inputs before creating a chat and validates the IPC boundary', async () => {
    const source = await original();
    const snapshot = source.manager.getRunSnapshot({ runId: source.runId })!;
    const aliases = snapshot.metrics.sourceAliases as Array<{ relativePath: string }>;
    expect(aliases).toHaveLength(1);
    writeFileSync(absoluteDataPath(aliases[0].relativePath), 'changed input');
    const count = listChats().length;
    expect(() => createMessageAttempt(source.messageId, 'Try again')).toThrow(/changed/);
    expect(listChats()).toHaveLength(count);
    const handlers = new Map<string, Function>();
    registerChatHandlers({ handle: (name, fn) => { handlers.set(name, fn); } });
    expect(() => handlers.get('workbench:createMessageAttempt')!({}, { messageId: '../escape', content: 'Edit' })).toThrow();
  });
  it('does not let an unrelated saved request or existing run be relabeled', async () => {
    const source = await original();
    const other = addMessage({ chat_id: createChat(), role: 'user', content: 'Different request' });
    await expect(source.manager.start({ chatId: source.chatId, userMessageId: other.id, userText: 'Different request' })).rejects.toThrow(/saved request/);
    await expect(source.manager.start({ chatId: source.chatId, userMessageId: source.messageId, userText: 'Inspect the attached notes' })).rejects.toThrow(/saved request/);
    const assistant = listMessages(source.chatId).find(message => message.role === 'assistant')!;
    expect(() => createMessageAttempt(assistant.id, 'Edit response')).toThrow(/user request/);
  });
});

describe('safe recovery controls', () => {
  it('resumes the same run and rechecks a saved output without generating it again', async () => {
    const saved = savedPartial(), { manager: runtime, gateway } = manager();
    const relativePath = writeRunFile(saved.runId, 'output', 'report.md', '# Saved report\n\nReviewed content.\n');
    const artifact = artifactRef(saved.runId, 'md', 'report.md', relativePath);
    getDb().prepare('INSERT INTO artifacts(artifact_id,run_id,kind,filename,relative_path,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(artifact.artifactId, saved.runId, artifact.kind, artifact.filename, artifact.relativePath, artifact.sizeBytes, artifact.sha256, artifact.createdAt);
    const before = readFileSync(absoluteDataPath(relativePath));
    expect(await runtime.resume(saved.runId)).toEqual({ runId: saved.runId });
    await terminal(saved.runId);
    expect(getState(saved.runId)).toBe('completed');
    expect(readFileSync(absoluteDataPath(relativePath))).toEqual(before);
    expect(runtime.getRunSnapshot({ runId: saved.runId })?.artifacts.map(item => item.artifactId)).toEqual([artifact.artifactId]);
    expect(gateway.chatWithTools).not.toHaveBeenCalled();
    expect(getExecutionLedger(saved.runId)?.resumeCount).toBe(1);
  });
  it('reports resumable work and remaining steps without spending a resume attempt', () => {
    const saved = savedPartial(), { manager: runtime } = manager();
    const recovery = runtime.getRunSnapshot({ runId: saved.runId })!.recovery!;
    expect(recovery.canResume).toBe(true); expect(recovery.remaining).toContain('produce report.md');
    expect(recovery.sourceMessageId).toBe(saved.messageId);
    expect(getExecutionLedger(saved.runId)?.resumeCount).toBe(0);
  });
  it('offers a fresh attempt for Chat and refuses to resume it without spending its allowance', async () => {
    const saved = savedPartial('chat'), { manager: runtime } = manager();
    expect(runtime.getRunSnapshot({ runId: saved.runId })!.recovery).toMatchObject({ canResume: false, sourceMessageId: saved.messageId });
    await expect(runtime.resume(saved.runId)).rejects.toThrow(/new Chat request/);
    expect(getExecutionLedger(saved.runId)?.resumeCount).toBe(0);
  });
  it('expires approvals on restart and blocks uncertain mutations without replay', async () => {
    const saved = savedPartial(), { manager: runtime, gateway } = manager();
    // Model a process stop during a mutation, then run the real startup reconciliation.
    getDb().prepare("UPDATE runs SET state='acting' WHERE id=?").run(saved.runId);
    updateExecutionLedgerState(saved.runId, 'acting');
    recordExecutionToolStarted({ runId: saved.runId, callId: 'write', tool: 'write_file', args: { path: 'report.md' }, summary: 'Writing report' });
    const approval = createConfirmation(saved.runId, 'plan_approval', 'Saved plan', 'Approve plan');
    reconcileInterruptedExecutions(); recoverInterruptedModeRuns();
    expect(runtime.getRunSnapshot({ runId: saved.runId })!.recovery).toMatchObject({ canResume: false, reason: expect.stringMatching(/uncertain mutation/) });
    expect(getDb().prepare('SELECT outcome FROM confirmations WHERE action_id=?').get(approval.actionId)).toMatchObject({ outcome: expect.stringMatching(/cancelled|expired/) });
    await expect(runtime.resume(saved.runId)).rejects.toThrow(/uncertain mutation/);
    expect(gateway.chatWithTools).not.toHaveBeenCalled();
    expect(getExecutionLedger(saved.runId)?.resumeCount).toBe(0);
  });
  it('keeps a changed-source failure retryable and does not spend a resume attempt', async () => {
    const saved = savedPartial(), { manager: runtime } = manager();
    const file = path.join(dir, 'runs', saved.runId, 'input', 'notes.txt');
    writeFileSync(file, 'original');
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    getDb().prepare('UPDATE run_mode_details SET metrics_json=? WHERE run_id=?').run(JSON.stringify({ sourceAliases: [{ relativePath: `runs/${saved.runId}/input/notes.txt`, sha256 }] }), saved.runId);
    writeFileSync(file, 'changed');
    await expect(runtime.resume(saved.runId)).rejects.toThrow(/changed or is missing/);
    expect(getExecutionLedger(saved.runId)?.resumeCount).toBe(0); expect(getState(saved.runId)).toBe('partial');
  });
  it('does not offer Resume when the saved work budget is exhausted', async () => {
    const saved = savedPartial(), { manager: runtime } = manager();
    getDb().prepare('UPDATE run_mode_details SET metrics_json=? WHERE run_id=?').run(JSON.stringify({ modelCallCount: 24 }), saved.runId);
    expect(runtime.getRunSnapshot({ runId: saved.runId })!.recovery).toMatchObject({ canResume: false, reason: expect.stringMatching(/work budget/) });
    await expect(runtime.resume(saved.runId)).rejects.toThrow(/work budget/);
    expect(getExecutionLedger(saved.runId)?.resumeCount).toBe(0);
  });
});
