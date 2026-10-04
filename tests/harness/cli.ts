// This must run before dynamic backend imports: stdout belongs exclusively to JSONL.
import { format } from "node:util";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { commandSchema, type WorkerBootConfig, type WorkerMessage } from "./protocol.js";
import { EventStore } from "./event-store.js";
import { redact } from "../helpers/redact.js";

for (const level of ["log", "warn", "error", "info", "debug"] as const) console[level] = (...args: unknown[]) => { process.stderr.write(redact(`[${level}] ${format(...args)}\n`)); };
function output(message: WorkerMessage): void { process.stdout.write(`${JSON.stringify(message)}\n`); }

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(process.argv[2], "utf8")) as WorkerBootConfig;
  const { boot } = await import("./boot.js");
  const { sendUserMessage } = await import("./behavioral-adapter.js");
  const { getDb, closeDb } = await import("../../backend/src/main/persistence/db.js");
  const { RAGDatabase } = await import("../../ai/rag/db.js");
  const events = new EventStore(output);
  const backend = await boot(config, events);
  output({ version: 1, kind: "ready", registry: [...backend.gateway.registry.values()], channels: backend.ipc.channels() });
  let closing = false;
  const pending = new Set<number>();
  const rl = createInterface({ input: process.stdin });
  const send = z.object({ chat: z.string(), text: z.string(), files: z.array(z.string()).default([]), temperature: z.number().optional(), groundingEnabled: z.boolean().optional(), preferredRoute: z.string().optional(), generationBudgetProfile: z.enum(["default", "demo_fast"]).optional() }).strict();
  const invokable = new Set(["workbench:confirmAction", "workbench:cancelRun", "workbench:getMessages", "workbench:getArtifact", "workbench:getChatHistory"]);
  for await (const line of rl) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { output({ version: 1, kind: "response", id: 0, ok: false, e: "Invalid JSON" }); continue; }
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) { output({ version: 1, kind: "response", id: 0, ok: false, e: "Invalid command envelope" }); continue; }
    const cmd = parsed.data;
    if (pending.has(cmd.id)) { output({ version: 1, kind: "response", id: cmd.id, ok: false, e: "Duplicate pending command ID" }); continue; }
    if (cmd.c === "shutdown") {
      closing = true; events.close();
      for (const chat of backend.chats.values()) {
        const runs = backend.manager.history().filter((run) => run.chatId === chat);
        for (const run of runs) try { backend.manager.cancel(run.runId); } catch {}
      }
      RAGDatabase.close(); closeDb(); output({ version: 1, kind: "response", id: cmd.id, ok: true }); rl.close(); break;
    }
    if (closing) continue;
    pending.add(cmd.id);
    // Do not await dispatch here: confirms and cancels must remain usable during waits.
    void (async () => {
      let data: unknown;
      if (cmd.c === "send") {
        const args = send.parse(cmd.a);
        data = await sendUserMessage(backend.ipc, await backend.ensureChat(args.chat), args.text, path.join(config.root, "attachments"), { ...args, files: args.files });
      } else if (cmd.c === "invoke") {
        const args = z.object({ channel: z.string(), input: z.unknown().optional() }).strict().parse(cmd.a);
        if (config.campaignType !== "boundary" && !invokable.has(args.channel)) throw new Error("IPC channel unavailable in behavioral mode");
        data = await backend.ipc.invoke(args.channel, args.input);
      } else if (cmd.c === "wait") {
        const a = z.object({ runId: z.string(), type: z.string(), state: z.string().optional(), after: z.number().int().nonnegative().default(0), timeoutMs: z.number().int().positive().max(600000).default(60000) }).strict().parse(cmd.a);
        data = await events.wait(a.runId, a.type, a.state, a.after, a.timeoutMs);
      } else {
        const db = getDb();
        data = { chats: [...backend.chats.entries()], messages: db.prepare("SELECT * FROM messages ORDER BY chat_id,seq").all(), runs: db.prepare("SELECT * FROM runs").all(), confirmations: db.prepare("SELECT * FROM confirmations").all(), artifacts: db.prepare("SELECT * FROM artifacts").all() };
      }
      output({ version: 1, kind: "response", id: cmd.id, ok: true, d: data });
    })().catch((error) => output({ version: 1, kind: "response", id: cmd.id, ok: false, e: redact(error instanceof Error ? error.message : String(error)) })).finally(() => pending.delete(cmd.id));
  }
  events.close();
}
main().catch((error) => { output({ version: 1, kind: "fatal", e: redact(String(error)) }); process.exitCode = 2; });
