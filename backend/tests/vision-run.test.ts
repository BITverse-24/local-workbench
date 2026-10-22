import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCanvas } from 'canvas';
import { RunManager } from '../src/main/run/manager.js';
import { closeDb, initDb } from '../src/main/persistence/db.js';
import { createChat } from '../src/main/persistence/chats.js';

import { modeGateway, fixtureIntent } from './helpers/mode-gateway.js';
import type { ModelRequest, RunEvent } from '../src/shared/contracts.js';

describe('Chat and Work visual source paths', () => {

  let root: string, events: RunEvent[];

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'wb-vision-'));
    process.env.WORKBENCH_DATA_ROOT = path.join(root, 'data');
    initDb(path.join(root, 'db.sqlite'));
    events = [];
  });

  afterEach(() => {
    closeDb();
    delete process.env.WORKBENCH_DATA_ROOT;
    rmSync(root, { recursive: true, force: true });
  });

  function setup(work = false) {

    const requests: ModelRequest[] = [];

    const fixture = modeGateway(fixtureIntent('Prepare approval note', work ? [{ type: 'docx', filename: 'approval-note.docx' }] : []), messages => '# Inspection review\nTube wall thickness below threshold. Minor glare on bottom margin.\n' + String(messages[0].content).split('SOURCES:\n')[1]);

    fixture.execute.mockImplementation(async req => {

      requests.push(req);

      if (req.taskType === 'vision') return { ok: true, value: { result: { sourceText: 'Inspection Report 101. Tube wall thickness is 3.5mm.', findings: [{ findingId: 'f1', title: 'Tube wall thickness below threshold', value: '3.5mm', confidence: 'high', evidence: 'Visible reading: 3.5mm', pageReferenceIds: ['p1'] }], pageReferences: [{ id: 'p1', page: 1, text: 'wall thickness 3.5mm' }], warnings: [] } } } as any;

      return { ok: true, value: { result: fixtureIntent('Prepare approval note', [{ type: 'docx', filename: 'approval-note.docx' }]) } } as any;

    });

    const manager = new RunManager(fixture.gateway, event => events.push(event));
    return { manager, requests, fixture };

  }

  function raster(color = 'red') {
    const canvas = createCanvas(320, 240);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = color;
    ctx.fillRect(30, 40, 120, 130);
    return canvas.toBuffer('image/png');
  }

  async function run(manager: RunManager, filename: string, bytes: Buffer, mediaType: string, mode: 'chat' | 'work', text: string) {
    const chatId = createChat();
    const { attachment } = manager.registerAttachment({ chatId, filename, mediaType, sizeBytes: bytes.length, base64OrBuffer: bytes });
    const { runId } = await manager.start({ chatId, mode, userText: text, attachmentToken: attachment.attachmentId });
    await vi.waitFor(() => expect(events.some(e => e.runId === runId && e.type === 'run_state' && e.state === 'completed'), JSON.stringify(events.filter(e => e.type === 'error'))).toBe(true), { timeout: 5000 });
    return runId;
  }

  it('uses configured vision fallback for raster input then answers in Chat', async () => {
    const { manager, requests, fixture } = setup();
    await run(manager, 'scan.png', raster(), 'image/png', 'chat', 'Review this scan');
    expect(requests.filter(r => r.taskType === 'vision')).toHaveLength(1);
    expect(requests[0].modelId).toBe('vision-fallback');
    expect(fixture.chat).toHaveBeenCalledTimes(1);
    expect(events.some(e => e.type === 'assistant_message' && e.text.includes('Tube wall thickness below threshold'))).toBe(true);
    expect(events.some(e => e.type === 'assistant_message' && e.text.includes('Minor glare'))).toBe(true);
    expect(events.some(e => e.type === 'artifact_ready')).toBe(false);
  });

  it('carries visual findings into a saved and validated Work document', async () => {
    const { manager, requests } = setup(true);
    await run(manager, 'vessel.png', raster('blue'), 'image/png', 'work', 'Read this scan and create approval-note.docx');
    expect(requests.filter(r => r.taskType === 'vision')).toHaveLength(1);
    const artifact = events.find(e => e.type === 'artifact_ready');
    expect(artifact?.type === 'artifact_ready' && artifact.artifact.filename).toBe('approval-note.docx');
    expect(events.some(e => e.type === 'confirmation_required')).toBe(false);
  });

  it('extracts digital PDF text without a vision call', async () => {
    const { manager, requests, fixture } = setup();
    await run(manager, 'report.pdf', readFileSync(path.resolve('tests/fixtures/demo/flow_a/scenario-1/inspection-report-E201.pdf')), 'application/pdf', 'chat', 'Read this report');
    expect(requests).toHaveLength(0);
    expect(fixture.turns[0].at(-1).content).toContain('4.6');
    expect(fixture.chat).toHaveBeenCalledTimes(1);
  });

  it('inspects vector drawing pixels even when digital labels are available', async () => {
    const { manager, requests, fixture } = setup();
    await run(manager, 'drawing.svg', readFileSync(path.resolve('demo/flow_c/scenario-1/pump-skid-P204.svg')), 'image/svg+xml', 'chat', 'Inspect this engineering drawing P&ID');
    expect(requests.filter(r=>r.taskType==='vision').length).toBeGreaterThan(0);
    expect(fixture.turns.at(-1)!.at(-1).content).toContain('XV-204');
    expect(fixture.turns.at(-1)!.at(-1).content).toContain('DN80');
  });

  it('renders an image-only multi-page PDF and retains bounded visual evidence', async () => {
    const { manager, requests } = setup();
    const canvas = createCanvas(600, 400, 'pdf');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(10, 20, 100, 100);
    (ctx as any).addPage();
    ctx.fillStyle = 'blue';
    ctx.beginPath();
    ctx.arc(200, 150, 50, 0, 2 * Math.PI);
    ctx.fill();
    await run(manager, 'scanned.pdf', canvas.toBuffer(), 'application/pdf', 'chat', 'Describe these scanned pages');
    expect(requests.filter(r => r.taskType === 'vision').length).toBeGreaterThan(1);
    expect(events.some(e => e.type === 'tool_result' && e.tool === 'extract_document' && e.ok)).toBe(true);
    expect((requests.find(r => r.taskType === 'vision') as any)?.attachment?.filename).toBe('source-page-1.jpg');
  });
});
