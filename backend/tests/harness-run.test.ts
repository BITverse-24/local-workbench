import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RunManager } from '../src/main/run/manager.js';
import { HarnessManager } from '../src/main/harness/harness-manager.js';
import { closeDb, initDb } from '../src/main/persistence/db.js';
import { createChat } from '../src/main/persistence/chats.js';
import { addMessage } from '../src/main/persistence/messages.js';
import { resolveRunPath } from '../src/main/run/filesystem.js';
import { modeGateway, fixtureIntent } from './helpers/mode-gateway.js';
import type { RunEvent } from '../src/shared/contracts.js';

describe('Workspace execution through explicit modes', () => {

  let root: string, workspace: string, events: RunEvent[], manager: RunManager;

  beforeEach(() => {
    vi.stubEnv('WORKBENCH_AGENT_V2', 'true');
    root = mkdtempSync(path.join(os.tmpdir(), 'wb-harness-run-'));
    workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    process.env.WORKBENCH_DATA_ROOT = path.join(root, 'data');
    initDb(path.join(root, 'db.sqlite'));
    events = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  function setup(intent: Record<string, unknown>, generation: Parameters<typeof modeGateway>[1], mount = true, approve = true) {

    const fixture = modeGateway(intent, generation);

    manager = new RunManager(fixture.gateway, event => {
      events.push(event);
      if (approve && event.type === 'confirmation_required') void manager.confirm({ runId: event.runId, actionId: event.action.actionId, approved: true });
    });

    const harness = new HarnessManager();
    manager.setHarness(harness);
    if (mount) harness.registerWorkspace(workspace);
    return fixture;

  }

  function action(tool: string, args: Record<string, unknown>) {
    return { content: null, tool_calls: [{ id: String(Math.random()), name: tool, arguments: args }] };
  }

  function mutation(targets: string[], operation = 'write') {
    return fixtureIntent('Change the requested workspace files', [], { intentType: 'code_modification', taskType: 'code', isActionable: true, chatResponseOnly: false, workspaceMutationRequested: true, targetFiles: targets, workspaceOperations: targets.map(targetPath => ({ operation, targetPath })) });
  }

  async function terminal(runId: string, state = 'completed') {
    await vi.waitFor(() => expect(events.some(e => e.runId === runId && e.type === 'run_state' && e.state === state), JSON.stringify(events.filter(e => e.type === 'error'))).toBe(true), { timeout: 5000 });
  }

  it('writes an authorized file and records the real tool result', async () => {
    let turn = 0;
    setup(mutation(['hello.txt']), () => ++turn === 1 ? action('write_file', { path: 'hello.txt', content: 'hello' }) : 'Created hello.txt');
    const { runId } = await manager.start({ mode: 'agent', userText: 'Write hello to hello.txt in the workspace' });
    await terminal(runId);
    expect(readFileSync(path.join(workspace, 'hello.txt'), 'utf8')).toBe('hello');
    expect(events.some(e => e.type === 'tool_result' && e.tool === 'write_file' && e.ok)).toBe(true);
    expect(events.some(e => e.type === 'routing' && e.modelId === 'primary-model' && e.taskType === 'code')).toBe(true);
    expect(events.filter(e => e.type === 'artifact_ready')).toHaveLength(0);
  });

  it('requires real execution after an unsupported text-only completion', async () => {
    let turn = 0;
    setup(mutation(['greeting.txt']), () => ++turn === 1 ? 'hello' : turn === 2 ? action('write_file', { path: 'greeting.txt', content: 'hello world\n' }) : 'Created greeting.txt');
    const { runId } = await manager.start({ mode: 'agent', userText: 'Write hello world to greeting.txt in the workspace' });
    await terminal(runId);
    expect(readFileSync(path.join(workspace, 'greeting.txt'), 'utf8')).toBe('hello world\n');
    expect(turn).toBeGreaterThan(1);
  });

  it('uses one Chat generation with no active workspace', async () => {
    const fixture = setup(fixtureIntent('Say hello'), () => 'Hello! How can I help you today?', false);
    const { runId } = await manager.start({ mode: 'chat', userText: 'Say hello' });
    await terminal(runId);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.chat).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === 'assistant_message' && e.text === 'Hello! How can I help you today?')).toBe(true);
  });

  it('does not execute Python text as an implicit workspace write', async () => {
    setup(fixtureIntent('Explain file creation'), () => "with open('sample.txt', 'w') as file:\n    file.write('sample')");
    const { runId } = await manager.start({ mode: 'chat', userText: 'Write sample.txt' });
    await terminal(runId);
    expect(existsSync(path.join(workspace, 'sample.txt'))).toBe(false);
    expect(events.filter(e => e.type === 'tool_call' || e.type === 'artifact_ready')).toHaveLength(0);
  });

  it('creates a downloadable text file in Work without a workspace', async () => {
    setup(fixtureIntent('Write sample', [{ type: 'file', filename: 'sample.txt' }]), () => 'sample', false);
    const { runId } = await manager.start({ mode: 'work', userText: 'Create sample.txt containing sample' });
    await terminal(runId);
    const artifact = events.find(e => e.type === 'artifact_ready');
    expect(artifact?.type === 'artifact_ready' && artifact.artifact.filename).toBe('sample.txt');
    expect(readFileSync(resolveRunPath(runId, 'output/sample.txt', 'output'), 'utf8')).toBe('sample');
  });

  it('keeps standalone Work output separate from a mounted workspace', async () => {
    setup(fixtureIntent('Write standalone output', [{ type: 'file', filename: 'sample.txt' }]), () => 'isolated from workspace');
    const { runId } = await manager.start({ mode: 'work', userText: 'Create sample.txt but do not save it in the workspace' });
    await terminal(runId);
    expect(readdirSync(workspace)).toEqual([]);
    expect(readFileSync(resolveRunPath(runId, 'output/sample.txt', 'output'), 'utf8')).toBe('isolated from workspace');
  });

  it('accepts native directory calls and returns the final answer without raw JSON', async () => {
    let turn = 0;
    setup(fixtureIntent('List workspace', [], { intentType: 'file_inspection', taskType: 'code', isActionable: true, chatResponseOnly: false }), () => ++turn === 1 ? action('list_dir', { path: '.' }) : 'Exploration completed successfully.');
    const { runId } = await manager.start({ mode: 'agent', userText: 'List files in the workspace' });
    await terminal(runId);
    expect(events.some(e => e.type === 'tool_result' && e.tool === 'list_dir' && e.ok)).toBe(true);
    expect(events.some(e => e.type === 'assistant_message' && e.text === 'Exploration completed successfully.')).toBe(true);
  });

  it('creates a valid Word document in Work with the primary model', async () => {
    setup(fixtureIntent('Draft approval note', [{ type: 'docx', filename: 'approval-note.docx' }]), () => '# Approval Note: Proposed Reactor Maintenance Shutdown\n\nApproval pending.');
    const { runId } = await manager.start({ mode: 'work', userText: 'Draft an approval note as approval-note.docx' });
    await terminal(runId);
    expect(readdirSync(workspace)).toEqual([]);
    const artifact = events.find(e => e.type === 'artifact_ready');
    expect(artifact?.type === 'artifact_ready' && artifact.artifact.kind).toBe('docx');
    expect(readFileSync(resolveRunPath(runId, 'output/approval-note.docx', 'output')).subarray(0, 2).toString()).toBe('PK');
    expect(events.some(e => e.type === 'routing' && e.modelId === 'primary-model')).toBe(true);
  });

  it('does not automatically import a prior Work document from a Chat follow-up', async () => {
    const chatId = createChat();
    setup(fixtureIntent('Create note', [{ type: 'docx', filename: 'approval-note.docx' }]), () => '# Review note\nApproval pending.');
    const first = await manager.start({ mode: 'work', chatId, userText: 'Create approval-note.docx' });
    await terminal(first.runId);
    const fixture = setup(fixtureIntent('Explain save action'), () => 'Select Agent to save the document to the workspace.');
    const second = await manager.start({ mode: 'chat', chatId, userText: 'Save it in the workspace' });
    await terminal(second.runId);
    expect(readdirSync(workspace)).toEqual([]);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.turns[0].some(m => String(m.content).includes('approval-note.docx'))).toBe(true);
  });

  it('preserves conversation history across runs', async () => {
    const fixture = setup(fixtureIntent('Explain procedure'), () => 'Step 2 involves cooling loop inspection.', false);
    const chatId = createChat();
    addMessage({ chat_id: chatId, role: 'user', content: 'What is the cooling procedure?' });
    const first = await manager.start({ mode: 'chat', chatId, userText: 'What is the cooling procedure?' });
    await terminal(first.runId);
    const second = await manager.start({ mode: 'chat', chatId, userText: 'Summarize step 2' });
    await terminal(second.runId);
    expect(fixture.turns[1].some(m => m.role === 'user' && String(m.content).includes('cooling procedure'))).toBe(true);
    expect(fixture.turns[1].some(m => m.role === 'assistant' && String(m.content).includes('cooling loop inspection'))).toBe(true);
  });

  it('starts a client-provided staging run ID cleanly', async () => {
    setup(fixtureIntent('Say hi'), () => 'Hello from test!', false);
    const custom = '11111111-2222-3333-4444-555555555555';
    const started = await manager.start({ mode: 'chat', runId: custom, userText: 'Say hi' });
    expect(started.runId).toBe(custom);
    await terminal(custom);
  });

  it('returns requested C++ code in Chat without executing it', async () => {
    setup(fixtureIntent('Explain Two Sum'), () => '```cpp\nvector<int> twoSum(vector<int>& nums, int target) { return {}; }\n```', false);
    const { runId } = await manager.start({ mode: 'chat', userText: 'Give the Two Sum solution in C++' });
    await terminal(runId);
    expect(events.some(e => e.type === 'assistant_message' && e.text.includes('vector<int> twoSum'))).toBe(true);
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(0);
  });

  it('passes prior history once as messages for an Agent run', async () => {
    const fixture = setup(fixtureIntent('Inspect workspace', [], { intentType: 'file_inspection', taskType: 'code', isActionable: true, chatResponseOnly: false }), () => 'Workspace inspected.');
    const chatId = createChat();
    addMessage({ chat_id: chatId, role: 'user', content: 'Hey!' });
    addMessage({ chat_id: chatId, role: 'assistant', content: 'Hello!' });
    const { runId } = await manager.start({ mode: 'agent', chatId, userText: 'Explain the workspace' });
    await terminal(runId);
    expect(fixture.turns[0].filter(m => m.role === 'user' && m.content === 'Hey!')).toHaveLength(1);
    expect(fixture.turns[0].at(-1).content).not.toContain('Prior Conversation Context');
  });

  it('performs explicitly authorized delete and write operations together', async () => {
    writeFileSync(path.join(workspace, 'old.py'), 'broken_code = True\n');
    let turn = 0;
    setup({ ...mutation(['old.py', 'repaired.py']), workspaceOperations: [{ operation: 'delete', targetPath: 'old.py' }, { operation: 'write', targetPath: 'repaired.py' }], validationRequested: false }, () => ++turn === 1 ? { content: null, tool_calls: [{ id: 'delete', name: 'delete_file', arguments: { path: 'old.py' } }, { id: 'write', name: 'write_file', arguments: { path: 'repaired.py', content: "print('all fixed')\n" } }] } : 'Deleted old.py and saved repaired.py');
    const { runId } = await manager.start({ mode: 'agent', userText: 'Delete old.py and write repaired.py containing print(\'all fixed\')' });
    await terminal(runId);
    expect(existsSync(path.join(workspace, 'old.py'))).toBe(false);
    expect(readFileSync(path.join(workspace, 'repaired.py'), 'utf8')).toBe("print('all fixed')\n");
    expect(events.some(e => e.type === 'confirmation_required')).toBe(true);
  });

  it('deletes an obsolete file through the authorized delete tool', async () => {
    writeFileSync(path.join(workspace, 'obsolete.py'), 'print(1)');
    let turn = 0;
    setup(mutation(['obsolete.py'], 'delete'), () => ++turn === 1 ? action('delete_file', { path: 'obsolete.py' }) : 'Deleted obsolete.py');
    const { runId } = await manager.start({ mode: 'agent', userText: 'Delete obsolete.py from the workspace' });
    await terminal(runId);
    expect(existsSync(path.join(workspace, 'obsolete.py'))).toBe(false);
    expect(events.filter(e => e.type === 'artifact_ready')).toHaveLength(0);
  });

  it('does not treat a zero-byte write as a verified deletion', async () => {
    writeFileSync(path.join(workspace, 'obsolete.py'), 'print(1)');
    let turn = 0;
    setup(mutation(['obsolete.py'], 'delete'), () => ++turn === 1 ? action('write_file', { path: 'obsolete.py', content: '' }) : action('delete_file', { path: 'obsolete.py' }));
    const { runId } = await manager.start({ mode: 'agent', userText: 'Delete obsolete.py from the workspace' });
    await terminal(runId);
    expect(existsSync(path.join(workspace, 'obsolete.py'))).toBe(false);
    expect(events.some(e => e.type === 'tool_result' && e.tool === 'delete_file' && e.ok)).toBe(true);
    expect(events.filter(e => e.type === 'artifact_ready')).toHaveLength(0);
  });

  it('returns distinct model health records', async () => {
    const gateway = { healthDistinct: vi.fn().mockResolvedValue([{ modelId: 'local-model', port: 1234, available: true }]), health: vi.fn() };
    manager = new RunManager(gateway as any);
    expect(await manager.health()).toEqual([{ modelId: 'local-model', port: 1234, available: true }]);
    expect(gateway.health).not.toHaveBeenCalled();
  });
});
