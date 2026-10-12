import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb, getDb } from '../src/main/persistence/db.js';
import { createChat, getChat, listChats, renameChat, fallbackChatTitle, claimChatTitle, applyGeneratedChatTitle } from '../src/main/persistence/chats.js';
import { handleSendMessage } from '../src/main/ipc/handlers.js';
import { ModelGateway } from '../src/main/gateway/model-gateway.js';
import { RunManager } from '../src/main/run/manager.js';
import { HarnessManager } from '../src/main/harness/harness-manager.js';
import { getState } from '../src/main/run/store.js';
import { absoluteDataPath, setDataDir, createRunDirectories } from '../src/main/run/filesystem.js';
import { snapshotWorkspaceReferences, suggestWorkspacePaths, walkWorkspace } from '../src/main/harness/workspace-references.js';
import { formatWorkspaceMention, parseWorkspaceMentions, workspaceMentionQuery } from '../src/shared/workspace-mentions.js';
import { startRunSchema } from '../src/main/ipc/validators.js';
import { prepareSources } from '../src/main/run/source-preparation.js';
import type { ChatTitleEvent } from '../src/shared/contracts.js';

let dir: string, root: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'chat-ux-')));
  root = path.join(dir, 'workspace'); mkdirSync(root);
  setDataDir(dir); initDb(path.join(dir, 'db.sqlite'));
});
afterEach(() => { vi.restoreAllMocks(); closeDb(); rmSync(dir, { recursive: true, force: true }); });
const terminal = async (runId: string) => vi.waitFor(() => expect(['completed','partial','failed','cancelled']).toContain(getState(runId)));
const saveUser = (chatId: string, content: string) => handleSendMessage({ chatId, role: 'user', content });

function setup() {
  const gateway = new ModelGateway();
  vi.spyOn(gateway, 'chatWithTools').mockResolvedValue({ ok: true, value: { content: 'Response', tool_calls: [], finishReason: 'stop' } } as any);
  vi.spyOn(gateway, 'generateChatTitle').mockResolvedValue('Review workspace source files');
  const events: ChatTitleEvent[] = [];
  const manager = new RunManager(gateway, undefined, event => events.push(event));
  const harness = new HarnessManager(); manager.setHarness(harness);
  const workspace = harness.registerWorkspace(root);
  return { gateway, manager, workspace, harness, events };
}

describe('chat titles', () => {
  it('names both pre-created and first-send chats from the first saved message', () => {
    for (const chatId of [createChat('New chat'), createChat()]) {
      const saved = saveUser(chatId, 'Explain how thermal expansion affects this part and its mounting');
      expect(saved.chatTitle?.title).toBe('Explain how thermal expansion affects this part and its');
      expect(getChat(chatId)?.title).not.toBe('New chat');
      expect(saveUser(chatId, 'A second topic').chatTitle).toBeUndefined();
    }
  });
  it('uses complete words and attachment names for an empty prompt', () => {
    expect(fallbackChatTitle('abc '.repeat(30)).length).toBeLessThanOrEqual(60);
    expect(fallbackChatTitle('', ['inspection.pdf'])).toBe('Review inspection.pdf');
    const { manager } = setup(); const chatId = createChat();
    const source = manager.registerAttachment({ chatId, filename: 'inspection.txt', mediaType: 'text/plain', sizeBytes: 4, base64OrBuffer: Buffer.from('data') });
    expect(handleSendMessage({ chatId, role: 'user', content: '', attachmentIds: [source.attachment.attachmentId] }).chatTitle?.title).toBe('Review inspection.txt');
  });
  it('repairs old placeholders on load and preserves unknown or manual titles', () => {
    const chatId = createChat('New Chats'); saveUser(chatId, 'Inspect the pressure vessel');
    getDb().prepare("UPDATE chats SET title='Untitled Chat',metadata='{}' WHERE id=?").run(chatId);
    expect(listChats().find(chat => chat.id === chatId)?.title).toBe('Inspect the pressure vessel');
    const custom = createChat('My chosen name'); saveUser(custom, 'Unrelated request');
    expect(getChat(custom)?.title).toBe('My chosen name');
    renameChat(chatId, 'New chat');
    expect(listChats().find(chat => chat.id === chatId)?.title).toBe('New chat');
  });
  it('persists the attempt and rejects delayed titles after a manual rename', () => {
    const chatId = createChat(); saveUser(chatId, 'Inspect the input file');
    const revision = claimChatTitle(chatId)!;
    expect(claimChatTitle(chatId)).toBeUndefined();
    renameChat(chatId, 'Operator title');
    expect(applyGeneratedChatTitle(chatId, 'Inspect source input file', revision)).toBeUndefined();
    expect(getChat(chatId)?.title).toBe('Operator title');
    closeDb(); initDb(path.join(dir, 'db.sqlite'));
    expect(claimChatTitle(chatId)).toBeUndefined();
  });
  it('emits a model title for the owning chat after the run ends', async () => {
    const { manager, events, gateway } = setup(); const chatId = createChat(); saveUser(chatId, 'Inspect source files');
    const other = createChat('Other chat');
    const { runId } = await manager.start({ chatId, userText: 'Inspect source files', mode: 'chat' });
    await terminal(runId);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].chatId).toBe(chatId);
    expect(getChat(other)?.title).toBe('Other chat');
    expect(gateway.chatWithTools).toHaveBeenCalledTimes(1);
    expect(manager.getRunSnapshot({ runId })?.metrics?.modelCallCount ?? 0).toBe(0); // fake gateway does not use inference
  });
  it('retains a fallback when the title model fails', async () => {
    const { manager, gateway } = setup(); vi.mocked(gateway.generateChatTitle).mockRejectedValue(new Error('offline'));
    const chatId = createChat(); saveUser(chatId, 'Inspect source files');
    const { runId } = await manager.start({ chatId, userText: 'Inspect source files' }); await terminal(runId);
    await vi.waitFor(() => expect(gateway.generateChatTitle).toHaveBeenCalledTimes(1));
    expect(getChat(chatId)?.title).toBe('Inspect source files'); expect(getState(runId)).toBe('completed');
  });
  it('uses an isolated maintenance request with a strict timeout and no progress events', async () => {
    const request = vi.fn(async (_url: string, _init: unknown, _timeoutMs: number) => ({ status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'Inspect source input files' } }] }) }));
    const registry = new Map([['title', { id: 'title', baseUrl: 'http://127.0.0.1:9999/v1', model: 'local', enabled: true,
      runtime: 'llama-server', taskTypes: ['draft'], capabilities: ['text'] } as any]]);
    const gateway = new ModelGateway({ request }, registry); const progress = vi.fn(); gateway.onProgress(progress);
    expect(await gateway.generateChatTitle('title', 'Inspect inputs')).toBe('Inspect source input files');
    expect(request.mock.calls[0][2]).toBe(10000); expect(progress).not.toHaveBeenCalled();
  });
});

describe('workspace mentions', () => {
  it('handles folders, Unicode, quoted spaces, extensionless files, and duplicate mentions', () => {
    const text = `Review ${formatWorkspaceMention('source files/試験.ts')} @src/ @README @src/`;
    expect(parseWorkspaceMentions(text)).toEqual([{ path: 'source files/試験.ts', kind: 'file' }, { path: 'src', kind: 'directory' }, { path: 'README', kind: 'file' }]);
    expect(workspaceMentionQuery('See @src/in', 11)?.query).toBe('src/in');
    expect(workspaceMentionQuery('email@example.com', 17)).toBeNull();
    expect(workspaceMentionQuery('See @"source fi', 15)?.query).toBe('source fi');
  });
  it('ranks full paths and excludes dependencies and symlinks', async () => {
    mkdirSync(path.join(root, 'a')); mkdirSync(path.join(root, 'b')); mkdirSync(path.join(root, 'node_modules'));
    writeFileSync(path.join(root, 'a', 'same.ts'), 'a'); writeFileSync(path.join(root, 'b', 'same.ts'), 'b');
    writeFileSync(path.join(root, 'node_modules', 'same.ts'), 'ignored'); symlinkSync(dir, path.join(root, 'escape'));
    expect((await suggestWorkspacePaths(root, 'same')).entries.map(entry => entry.name)).toEqual(['a/same.ts', 'b/same.ts']);
    expect((await suggestWorkspacePaths(root, 'escape')).entries).toEqual([]);
  });
  it('bounds folder lists and does not read descendant contents', async () => {
    mkdirSync(path.join(root, 'folder')); writeFileSync(path.join(root, 'folder', 'secret.txt'), 'CONTENT_MUST_NOT_BE_READ');
    const runId = randomUUID(); createRunDirectories(runId);
    const manifest = await snapshotWorkspaceReferences({ root, registeredAt: 'now', runId, references: [{ path: 'folder', kind: 'directory' }], uploadCount: 0, mode: 'chat', assertWorkspace: () => {} });
    expect(manifest.files).toEqual([]); expect(manifest.folderEvidence).toContain('folder/secret.txt'); expect(manifest.folderEvidence).not.toContain('CONTENT_MUST_NOT_BE_READ');
    expect((await walkWorkspace(root, '.', 1)).truncated).toBe(true);
    const evidence = await prepareSources([], '', { workspaceReferenceEvidence: manifest.folderEvidence } as any);
    expect(evidence).toContain('folder/secret.txt');
  });
  it('uses folder paths without importing files from the previous run', async () => {
    mkdirSync(path.join(root, 'folder')); writeFileSync(path.join(root, 'folder', 'notes.txt'), 'PRIVATE_DESCENDANT_TEXT');
    const { manager, gateway, workspace } = setup(); const chatId = createChat('Folder check');
    manager.registerAttachment({ chatId, filename: 'prior.txt', mediaType: 'text/plain', sizeBytes: 10, base64OrBuffer: Buffer.from('PRIOR_TEXT') });
    const { runId } = await manager.start({ chatId, userText: 'List @folder/', workspaceIdentity: workspace,
      workspaceReferences: [{ path: 'folder', kind: 'directory' }] });
    await terminal(runId);
    const evidence = String(vi.mocked(gateway.chatWithTools).mock.calls[0][1].at(-1)?.content);
    expect(evidence).toContain('folder/notes.txt'); expect(evidence).not.toContain('PRIVATE_DESCENDANT_TEXT'); expect(evidence).not.toContain('PRIOR_TEXT');
  });
  it('checks saved source digests before execution', async () => {
    writeFileSync(path.join(root, 'notes.txt'), 'Original evidence');
    const { manager, workspace } = setup();
    const { runId } = await manager.start({ chatId: createChat('Integrity check'), userText: 'Read @notes.txt', workspaceIdentity: workspace,
      workspaceReferences: [{ path: 'notes.txt', kind: 'file' }] });
    const saved = manager.getRunSnapshot({ runId })!.metrics!.workspaceManifest as { relativePath: string };
    const manifest = JSON.parse(readFileSync(absoluteDataPath(saved.relativePath), 'utf8'));
    writeFileSync(absoluteDataPath(manifest.files[0].relativePath), 'Changed evidence');
    await terminal(runId); expect(getState(runId)).toBe('failed');
  });
  it.each(['chat', 'work'] as const)('snapshots explicit files for %s without granting workspace tools', async mode => {
    writeFileSync(path.join(root, 'numbers.csv'), 'value\n12\n');
    const { manager, gateway, workspace } = setup();
    const { runId } = await manager.start({ chatId: createChat('Source check'), mode, userText: mode === 'work' ? 'Convert @numbers.csv to json' : 'Read @numbers.csv',
      workspaceIdentity: workspace, workspaceReferences: [{ path: 'numbers.csv', kind: 'file' }] });
    writeFileSync(path.join(root, 'numbers.csv'), 'value\n99\n');
    await terminal(runId); expect(getState(runId)).toBe('completed');
    const saved = manager.getRunSnapshot({ runId })!.metrics!.workspaceManifest as { relativePath: string };
    const manifest = JSON.parse(readFileSync(absoluteDataPath(saved.relativePath), 'utf8'));
    expect(readFileSync(absoluteDataPath(manifest.files[0].relativePath), 'utf8')).toContain('12');
    if (mode === 'chat') { const call = vi.mocked(gateway.chatWithTools).mock.calls[0]; expect(call[2]).toEqual([]); expect(String(call[1].at(-1)?.content)).toContain('12'); }
    expect(manager.getRunSnapshot({ runId })!.mode).toBe(mode);
  });
  it('rejects a stale workspace, escaped paths, missing and unsupported files, and source limits', async () => {
    const { manager, workspace } = setup();
    await expect(manager.start({ userText: 'Read @file.txt', workspaceIdentity: { ...workspace, registeredAt: 'old' }, workspaceReferences: [{ path: 'file.txt', kind: 'file' }] })).rejects.toThrow('Workspace changed');
    const runId = randomUUID(); createRunDirectories(runId);
    const options = { root, registeredAt: workspace.registeredAt, runId, uploadCount: 0, mode: 'chat' as const, assertWorkspace: () => {} };
    await expect(snapshotWorkspaceReferences({ ...options, references: [{ path: '../db.sqlite', kind: 'file' }] })).rejects.toThrow('escapes');
    await expect(snapshotWorkspaceReferences({ ...options, references: [{ path: 'missing.txt', kind: 'file' }] })).rejects.toThrow();
    writeFileSync(path.join(root, 'file.exe'), 'data');
    await expect(snapshotWorkspaceReferences({ ...options, references: [{ path: 'file.exe', kind: 'file' }] })).rejects.toThrow('Unsupported');
    await expect(snapshotWorkspaceReferences({ ...options, uploadCount: 10, references: [{ path: 'a.txt', kind: 'file' }] })).rejects.toThrow('10 files');
    writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(snapshotWorkspaceReferences({ ...options, references: [{ path: 'large.txt', kind: 'file' }] })).rejects.toThrow('10 MB');
    expect(startRunSchema.safeParse({ userText: 'Read source', workspaceReferences: [{ path: 'a', kind: 'unknown' }] }).success).toBe(false);
  });
});
