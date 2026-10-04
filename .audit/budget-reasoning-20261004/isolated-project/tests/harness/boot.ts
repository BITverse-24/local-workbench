import { readFileSync } from "node:fs";
import path from "node:path";
import type { WorkerBootConfig } from "./protocol.js";
import { FakeIpcRegistrar } from "../helpers/ipc-fake.js";
import { ModelGateway } from "../../backend/src/main/gateway/model-gateway.js";
import { initBackend } from "../../backend/src/main/index.js";
import { EventStore } from "./event-store.js";

export async function boot(config: WorkerBootConfig, events: EventStore) {
  const ipc = new FakeIpcRegistrar();
  const gateway = new ModelGateway(undefined, config.registry);
  const manager = initBackend(ipc, (event) => events.push(event), { dataDir: path.join(config.root, "data"), modelsPath: path.join(config.root, "config", "models.json"), schemaPath: config.schemaPath, embeddingConfig: config.embedding }, undefined, gateway);
  await manager.ragService.init();
  if (JSON.stringify([...gateway.registry.values()]) !== JSON.stringify(config.registry)) throw new Error("Effective model registry changed during startup");
  await ipc.invoke("workspace:register", { dirPath: path.join(config.root, "workspace") });
  for (const [i, doc] of config.setup.knowledgeBase.entries()) {
    await ipc.invoke("kb:ingestDoc", { doc_id: `fixture-${i}`, title: path.basename(doc.path), source_path: path.join(config.root, "kb", doc.path), page_count: doc.kind === "pdf" ? 1 : undefined });
  }
  const chats = new Map<string, string>();
  async function ensureChat(name: string): Promise<string> {
    let id = chats.get(name);
    if (!id) { id = (await ipc.invoke<{ chatId: string }>("workbench:createChat", { title: name })).chatId; chats.set(name, id); }
    return id;
  }
  for (const message of config.setup.conversation) {
    const chatId = await ensureChat(message.chat);
    await ipc.invoke("workbench:sendMessage", { chatId, role: message.role, content: message.content });
  }
  return { ipc, manager, ensureChat, chats, gateway };
}
