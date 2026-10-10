import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { initDb, closeDb, getDb } from "../src/main/persistence/db.js";
import { RunManager } from "../src/main/run/manager.js";
import { startRunSchema } from "../src/main/ipc/validators.js";
import { createChat } from "../src/main/persistence/chats.js";
import { modeGateway, fixtureIntent } from './helpers/mode-gateway.js';
import { resolveRunPath } from '../src/main/run/filesystem.js';
import type { ModelRequest, RunEvent } from "../src/shared/contracts.js";

describe("Multi-Attachment Support & Persistence", () => {

  let tempRoot: string;

  let manager: RunManager;

  let runEvents: RunEvent[];

  let capturedRequests: ModelRequest[];


  beforeEach(() => {

    tempRoot = mkdtempSync(path.join(os.tmpdir(), "wb-multi-att-test-"));

    process.env.WORKBENCH_DATA_ROOT = path.join(tempRoot, "data");

    initDb(path.join(tempRoot, "workbench.sqlite"));


    runEvents = [];

    capturedRequests = [];


    const fixture = modeGateway(fixtureIntent('Prepare a review note', [{ type: 'md', filename: 'review-note.md' }]), messages => '# Review note\n\n' + String(messages[0].content).split('SOURCES:\n')[1]);

    manager = new RunManager(fixture.gateway, event => runEvents.push(event));

  });


  afterEach(() => {

    closeDb();

    delete process.env.WORKBENCH_DATA_ROOT;

    rmSync(tempRoot, { recursive: true, force: true });

  });


  it("retains the full executed attachment group despite newer registration-only runs", () => {

    const chatId = createChat("Compare reports");

    const first = manager.registerAttachment({ chatId, filename: "first.txt", mediaType: "text/plain", sizeBytes: 12, base64OrBuffer: Buffer.from("first source") });

    const second = manager.registerAttachment({ chatId, filename: "second.txt", mediaType: "text/plain", sizeBytes: 13, base64OrBuffer: Buffer.from("second source") });

    const db = getDb();

    db.prepare("INSERT INTO run_attachments(run_id, attachment_id) VALUES (?, ?)").run(first.runId, second.attachment.attachmentId);

    db.prepare("UPDATE runs SET state='completed', completed_at=? WHERE id=?").run(new Date().toISOString(), first.runId);

    db.prepare("UPDATE runs SET created_at=? WHERE id=?").run("2099-01-01T00:00:00.000Z", second.runId);

    const retained = (manager as any).latestAttachments(chatId);

    expect(retained.map((file: any) => file.filename).sort()).toEqual(["first.txt", "second.txt"]);

  });


  it("validates startRunSchema with attachmentTokens array", () => {

    const validSingle = startRunSchema.safeParse({
      userText: "inspect report",
      attachmentToken: "123e4567-e89b-12d3-a456-426614174000",
    });

    expect(validSingle.success).toBe(true);


    const validMultiple = startRunSchema.safeParse({
      userText: "inspect multiple reports",
      attachmentTokens: [
        "123e4567-e89b-12d3-a456-426614174000",
        "223e4567-e89b-12d3-a456-426614174001",
      ],
    });

    expect(validMultiple.success).toBe(true);

    // Empty text without attachments should fail

    const invalidEmpty = startRunSchema.safeParse({
      userText: "",
    });

    expect(invalidEmpty.success).toBe(false);

  });


  it("rejects unsupported run fields; generation profiles are selected outside run payloads", () => {

    expect(startRunSchema.safeParse({ userText: "test", generationBudgetProfile: "demo_fast" }).success).toBe(false);

  });


  function upload(chatId: string, filename: string, content: Buffer, mediaType = 'text/plain') {

    return manager.registerAttachment({ chatId, filename, mediaType, sizeBytes: content.length, base64OrBuffer: content }).attachment;

  }

  async function completed(runId: string) {
    await vi.waitFor(() => expect(runEvents.some(e => e.runId === runId && e.type === 'run_state' && e.state === 'completed'), JSON.stringify(runEvents.filter(e => e.type === 'error'))).toBe(true), { timeout: 5000 });
  }

  it('persists all source IDs and distinct aliases in the execution run', async () => {

    const chatId = createChat('Multi-source');

    const a = upload(chatId, 'report.txt', Buffer.from('Subject: ALPHA\nFinding: leak'));

    const b = upload(chatId, 'report.txt', Buffer.from('Subject: BETA\nFinding: crack'));

    const { runId } = await manager.start({ chatId, mode: 'work', userText: 'Read all sources and draft review-note.md', attachmentTokens: [a.attachmentId, b.attachmentId] });

    await completed(runId);

    const rows = getDb().prepare('SELECT attachment_id FROM run_attachments WHERE run_id=?').all(runId) as any[];

    expect(rows.map(r => r.attachment_id).sort()).toEqual([a.attachmentId, b.attachmentId].sort());

    const output = readFileSync(resolveRunPath(runId, 'output/review-note.md', 'output'), 'utf8');

    expect(output).toContain('ALPHA');
    expect(output).toContain('BETA');
    expect(output).toContain('leak');
    expect(output).toContain('crack');

  });

  it('reads both real PDFs without knowledge retrieval when that source control is off', async () => {

    const chatId = createChat('Two PDFs');

    const a = upload(chatId, 'first.pdf', readFileSync(path.resolve('demo/flow_a/inspection-report-E201.pdf')), 'application/pdf');

    const b = upload(chatId, 'second.pdf', readFileSync(path.resolve('demo/flow_a/inspection-report-E202-followup.pdf')), 'application/pdf');

    const { runId } = await manager.start({ chatId, mode: 'work', groundingEnabled: false, userText: 'Read these reports and draft review-note.md', attachmentTokens: [a.attachmentId, b.attachmentId] });

    await completed(runId);

    expect(runEvents.some(e => e.type === 'tool_call' && e.tool === 'retrieve_knowledge')).toBe(false);

    const output = readFileSync(resolveRunPath(runId, 'output/review-note.md', 'output'), 'utf8');

    expect(output).toContain('first.pdf');
    expect(output).toContain('second.pdf');
    expect(output).toContain('E-201');
    expect(output).toContain('E-202');

  });

  it('retains the executed input group and prior output for a follow-up in the same chat', async () => {

    const chatId = createChat('Follow-up');
    const a = upload(chatId, 'source.txt', Buffer.from('Subject: MODULE\nFinding: inspect connector'));

    const b = upload(chatId, 'values.csv', Buffer.from('item,value\na,10\nb,20\n'), 'text/csv');

    const first = await manager.start({ chatId, mode: 'work', userText: 'Review all inputs as review-note.md', attachmentTokens: [a.attachmentId, b.attachmentId] });
    await completed(first.runId);

    const fixture = modeGateway(fixtureIntent('Summarize sources'), messages => {
      const prompt = String(messages.at(-1).content);
      expect(prompt).toContain('inspect connector');
      expect(prompt).toContain('a,10');
      expect(prompt).toContain('review-note.md');
      return 'The connector requires inspection. Values are 10 and 20.';
    });

    manager = new RunManager(fixture.gateway, event => runEvents.push(event));

    const second = await manager.start({ chatId, mode: 'chat', userText: 'Summarize review-note.md and the prior inputs' });
    await completed(second.runId);

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.chat).toHaveBeenCalledTimes(1);

  });
});
