import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunManager } from '../src/main/run/manager.js';
import { createChat } from '../src/main/persistence/chats.js';
import { closeDb, initDb } from '../src/main/persistence/db.js';
import { resolveRunPath } from '../src/main/run/filesystem.js';
import { parseFileIndependently } from '../src/main/tools/file-worker.js';
import { modeGateway, fixtureIntent } from './helpers/mode-gateway.js';
import type { RunEvent } from '../src/shared/contracts.js';

describe('Work computation and exports with real Python', () => {

  let root: string, events: RunEvent[], manager: RunManager;

  beforeEach(() => {
    root = mkdtempSync(path.join(process.cwd(), '.tmp-flow-b-'));
    process.env.WORKBENCH_DATA_ROOT = path.join(root, 'data');
    initDb(path.join(root, 'db.sqlite'));
    events = [];
  });

  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  const csv = 'name,value\na,10\nb,20\n';

  const readRows = "import csv\nwith open('input.csv', newline='') as handle:\n    rows = list(csv.DictReader(handle))\n";

  function setup(outputs: Array<{ type: string; filename: string }>, generate: Parameters<typeof modeGateway>[1], computation = false) {
    const fixture = modeGateway(fixtureIntent('Process the supplied CSV', outputs, computation ? { intentType: 'general_qa', taskType: 'code', isActionable: true, chatResponseOnly: false } : {}), generate);
    manager = new RunManager(fixture.gateway, event => {
      events.push(event);
      if (event.type === 'confirmation_required') {
        expect(event.action.kind).toBe('uncontained_python');
        void manager.confirm({ runId: event.runId, actionId: event.action.actionId, approved: true });
      }
    });
    return fixture;
  }

  function upload(chatId: string) {
    return manager.registerAttachment({ chatId, filename: 'input.csv', mediaType: 'text/csv', sizeBytes: Buffer.byteLength(csv), base64OrBuffer: Buffer.from(csv) }).attachment;
  }

  function python(code: string) {
    return { content: null, tool_calls: [{ id: String(Math.random()), name: 'execute_python', arguments: { filename: 'task.py', code, input_files: ['input.csv'] } }] };
  }

  async function completed(runId: string) {
    await vi.waitFor(() => expect(events.some(e => e.runId === runId && e.type === 'run_state' && e.state === 'completed'), JSON.stringify(events.filter(e => e.type === 'error'))).toBe(true), { timeout: 5000 });
  }

  it('computes actual row count after fallback approval without an unrequested artifact', async () => {
    let turn = 0;
    setup([], () => ++turn === 1 ? python(readRows + "print('ROWS', len(rows))\n") : 'ROWS 2', true);
    const chatId = createChat();
    const source = upload(chatId);
    const { runId } = await manager.start({ chatId, mode: 'work', userText: 'Compute the CSV row count and answer with ROWS and its count', attachmentToken: source.attachmentId });
    await completed(runId);
    expect(events.some(e => e.type === 'tool_result' && e.tool === 'execute_python' && e.ok && e.output?.includes('ROWS 2')), JSON.stringify(events)).toBe(true);
    expect(events.filter(e => e.type === 'artifact_ready')).toHaveLength(0);
    expect(events.filter(e => e.type === 'confirmation_required')).toHaveLength(1);
  });

  it('creates an independently parsed XLSX table only when requested', async () => {
    setup([{ type: 'xlsx', filename: 'csv-summary.xlsx' }], messages => {
      expect(messages[0].content).toContain('a,10');
      return '| Name | Value |\n| --- | --- |\n| a | 10 |\n| b | 20 |';
    });
    const chatId = createChat();
    const source = upload(chatId);
    const { runId } = await manager.start({ chatId, mode: 'work', userText: 'Export the supplied values as csv-summary.xlsx', attachmentToken: source.attachmentId });
    await completed(runId);
    const parsed = await parseFileIndependently(resolveRunPath(runId, 'output/csv-summary.xlsx', 'output'), 'xlsx');
    expect(parsed.rows.slice(0, 3)).toEqual([['Name', 'Value'], ['a', '10'], ['b', '20']]);
    expect(parsed.text).toContain('input.csv, page 1');
    expect(events.filter(e => e.type === 'confirmation_required')).toHaveLength(0);
  });

  it('stages the prior CSV for a follow-up and computes population standard deviation', async () => {
    let turn = 0;
    setup([], () => ++turn % 2 === 1 ? python(readRows + "import math\nvalues = [float(row['value']) for row in rows]\nmean = sum(values) / len(values)\nprint('STDDEV', math.sqrt(sum((v-mean)**2 for v in values)/len(values)))\n") : 'STDDEV 5.0', true);
    const chatId = createChat();
    const source = upload(chatId);
    const first = await manager.start({ chatId, mode: 'work', userText: 'Compute the population standard deviation', attachmentToken: source.attachmentId });
    await completed(first.runId);
    const second = await manager.start({ chatId, mode: 'work', userText: 'Compute the same population standard deviation again' });
    await completed(second.runId);
    expect(readFileSync(resolveRunPath(second.runId, 'input/input.csv', 'input'), 'utf8')).toBe(csv);
    expect(events.filter(e => e.type === 'tool_result' && e.tool === 'execute_python' && e.ok && e.output?.includes('STDDEV 5.0'))).toHaveLength(2);
  });

  it.each([{ type: 'file', kind: 'txt', filename: 'summary.txt', content: 'Summary: a=10; b=20' }, { type: 'csv', kind: 'csv', filename: 'summary.csv', content: 'name,value\na,10\nb,20\n' }, { type: 'md', kind: 'md', filename: 'summary.md', content: '# Summary\n\n| Name | Value |\n| --- | --- |\n| a | 10 |\n| b | 20 |' }])('saves the requested $kind export with its actual parser and extension', async spec => {
    let turn = 0;
    setup([{ type: spec.type, filename: spec.filename }], () => spec.type === 'csv' ? ++turn === 1 ? { content: null, tool_calls: [{ id: 'save', name: 'generate_deliverable', arguments: { type: 'csv', filename: spec.filename, content: spec.content } }] } : 'CSV export saved.' : spec.content);
    const chatId = createChat();
    const source = upload(chatId);
    const { runId } = await manager.start({ chatId, mode: 'work', userText: 'Create ' + spec.filename + ' from these values', attachmentToken: source.attachmentId });
    await completed(runId);
    const artifact = events.find(e => e.type === 'artifact_ready');
    expect(artifact?.type === 'artifact_ready' && artifact.artifact.kind).toBe(spec.kind);
    expect(readFileSync(resolveRunPath(runId, 'output/' + spec.filename, 'output'), 'utf8')).toContain('10');
    await parseFileIndependently(resolveRunPath(runId, 'output/' + spec.filename, 'output'), spec.kind);
    expect(events.filter(e => e.type === 'confirmation_required')).toHaveLength(0);
  });

  it('recovers from a real Python failure and reports both execution attempts', async () => {
    let turn = 0;
    setup([], () => ++turn === 1 ? python("raise ValueError('invalid first computation')\n") : turn === 2 ? python(readRows + "print('ROWS', len(rows))\n") : 'ROWS 2; the corrected computation succeeded.', true);
    const chatId = createChat();
    const source = upload(chatId);
    const { runId } = await manager.start({ chatId, mode: 'work', userText: 'Compute the CSV row count', attachmentToken: source.attachmentId });
    await completed(runId);
    expect(events.filter(e => e.type === 'tool_result' && e.tool === 'execute_python' && !e.ok)).toHaveLength(1);
    expect(events.filter(e => e.type === 'tool_result' && e.tool === 'execute_python' && e.ok)).toHaveLength(1);
    const failure = events.find((e): e is Extract<RunEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'execute_python' && !e.ok);
    expect(failure?.output).toContain('invalid first computation');
  });

  it('executes valid multiline with statements exactly as supplied', async () => {
    let turn = 0;
    const source = "import csv\nwith (\n    open('input.csv', newline='') as handle,\n):\n    rows = list(csv.DictReader(handle))\nprint('ROWS', len(rows))\n";
    setup([], () => ++turn === 1 ? python(source) : 'ROWS 2', true);
    const chatId = createChat();
    const attachment = upload(chatId);
    const { runId } = await manager.start({ chatId, mode: 'work', userText: 'Count the CSV rows', attachmentToken: attachment.attachmentId });
    await completed(runId);
    expect(readFileSync(resolveRunPath(runId, 'intermediate/task.py', 'intermediate'), 'utf8')).toBe(source);
    expect(events.some(e => e.type === 'tool_result' && e.tool === 'execute_python' && e.ok && e.output?.includes('ROWS 2')), JSON.stringify(events)).toBe(true);
  });

  it('fails honestly when the model claims success after an unresolved real tool error', async () => {

    let turn = 0;
    setup([], () => ++turn === 1 ? python("raise ValueError('cannot compute supplied input')\n") : 'ROWS 2; computation succeeded.', true);

    const chatId = createChat();
    const attachment = upload(chatId);
    const { runId } = await manager.start({ chatId, mode: 'work', userText: 'Count the supplied rows', attachmentToken: attachment.attachmentId });

    await vi.waitFor(() => expect(events.some(e => e.runId === runId && e.type === 'run_state' && e.state === 'failed')).toBe(true), { timeout: 5000 });

    expect(events.some(e => e.type === 'run_state' && e.state === 'completed')).toBe(false);

    expect(events.some(e => e.type === 'assistant_message' && e.text.includes('Actual tool failure:') && e.text.includes('cannot compute supplied input'))).toBe(true);

  });
});
