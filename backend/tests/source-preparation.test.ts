import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareSources } from '../src/main/run/source-preparation.js';
import { extractDocumentTool } from '../src/main/tools/specialist-tools.js';
import { createRunDirectories, resolveRunPath } from '../src/main/run/filesystem.js';
import { buildRegistryFromRows } from '../src/main/gateway/registry.js';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('../src/main/tools/file-worker.js', () => ({ parseFileIndependently: parse }));

describe('Source evidence cache', () => {
  let root: string;
  let previous: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'source-cache-'));
    previous = process.env.WORKBENCH_DATA_ROOT;
    process.env.WORKBENCH_DATA_ROOT = root;
    parse.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (previous === undefined) delete process.env.WORKBENCH_DATA_ROOT;
    else process.env.WORKBENCH_DATA_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  async function read(bytes: Buffer, filename: string, query: string, model = 'model-a') {
    const runId = randomUUID();
    createRunDirectories(runId);
    writeFileSync(resolveRunPath(runId, 'input/'+filename, 'input'), bytes);
    const relativePath = `runs/${runId}/input/${filename}`;
    return prepareSources([{ attachmentId: randomUUID(), filename, mediaType: 'application/octet-stream', sizeBytes: bytes.length, relativePath }], query,
      { runId, workspaceRoot: path.join(root, 'runs', runId, 'input'), gateway: { selectedModel: model } as any });
  }
  it('gets new vision evidence for image follow-ups, other chats and model changes', async () => {
    const extract = vi.spyOn(extractDocumentTool, 'execute').mockImplementation(async args => ({ output: `Evidence for ${args.query}`, summary: 'visual evidence' }));
    const bytes = Buffer.from(randomUUID());
    const first = await read(bytes, 'image.png', 'Describe colors');
    const second = await read(bytes, 'image.png', 'Read serial number');
    const third = await read(bytes, 'image.png', 'Read serial number', 'model-b');
    expect(first).toContain('Evidence for Describe colors');
    expect(second).toContain('Evidence for Read serial number');
    expect(second).not.toContain('Evidence for Describe colors');
    expect(third).toContain('Evidence for Read serial number');
    expect(extract).toHaveBeenCalledTimes(3);
  });
  it('does not cache vision answers for scanned PDFs', async () => {
    parse.mockResolvedValue({ text: '', pages: [{ pageNumber: 1, text: '' }] });
    const extract = vi.spyOn(extractDocumentTool, 'execute').mockImplementation(async args => ({ output: String(args.query), summary: 'visual evidence' }));
    const bytes = Buffer.from(randomUUID());
    await read(bytes, 'scanned.pdf', 'Read identifier');
    expect(await read(bytes, 'scanned.pdf', 'Read dimensions')).toContain('Read dimensions');
    expect(extract).toHaveBeenCalledTimes(2);
  });
  it('reuses deterministic digital extraction but selects excerpts for the current query', async () => {
    parse.mockResolvedValue({ text: 'Reliable extracted source text', pages: [{ pageNumber: 1, text: 'Reliable extracted source text' }] });
    const extract = vi.spyOn(extractDocumentTool, 'execute');
    const bytes = Buffer.from(randomUUID());
    await read(bytes, 'digital.pdf', 'first question');
    expect(await read(bytes, 'digital.pdf', 'second question')).toContain('Reliable extracted source text');
    expect(parse).toHaveBeenCalledTimes(1);
    expect(extract).not.toHaveBeenCalled();
  });
  it('preserves malformed CSV and JSON inputs as raw source evidence', async () => {
    parse.mockRejectedValue(new Error('CSV row widths differ'));
    const csv = 'name,note\n"pump","check, valve"\n\n';
    expect(await read(Buffer.from(csv), 'sample.csv', 'Repair the reader')).toContain(csv);
    const json = '{"unfinished":';
    expect(await read(Buffer.from(json), 'broken.json', 'Explain the parse error')).toContain(json);
  });
  it('does not infer vision capability for an unknown Coding or Draft endpoint', () => {
    for (const role of ['coding', 'draft'] as const) {
      const entries = buildRegistryFromRows([{ role, modelName: 'unknown-text-model', host: '127.0.0.1', port: 1234, contextLength: 8192 }]);
      expect(entries[0].capabilities).not.toContain('image-input');
      expect(entries).toHaveLength(1); // No unconfigured fallback endpoint is added.
      expect(entries.some(entry => entry.capabilities.includes('image-input'))).toBe(false);
    }
    const shared = buildRegistryFromRows(['draft', 'vision', 'coding'].map(role => ({ role: role as 'draft' | 'vision' | 'coding', modelName: 'declared-visual-model', host: '127.0.0.1', port: 1234, contextLength: 8192 })));
    expect(shared[0].capabilities).toContain('image-input');
  });
});
