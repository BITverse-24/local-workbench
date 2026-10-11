// Chat-IPC connection tests (backend/tests/ipc.test.ts).
// A fake ipcMain stands in for Electron: proves `registerChatHandlers` / `initBackend`
// wire every channel and that renderer-shaped payloads round-trip through SQLite.
// Run: npm --prefix backend run test -- ipc.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_CHANNELS,
  IPC_CHAT,
  IPC_RUN,
  RUN_CHANNELS,
  IPC_WORKSPACE,
  WORKSPACE_CHANNELS,
  KB_CHANNELS,
  ONBOARDING_CHANNELS,
} from "../src/main/ipc/channels.js";
import { registerChatHandlers, type MinimalIpcMain } from "../src/main/ipc/handlers.js";
import { initBackend } from "../src/main/index.js";
import { closeDb, initDb } from "../src/main/persistence/db.js";

const UUID4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Minimal Electron ipcMain stand-in: records handlers, invoke() mimics renderer. */
class FakeIpcMain implements MinimalIpcMain {
  handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void {
    this.handlers.set(channel, listener);
  }
  async invoke(channel: string, input: unknown): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn({}, input);
  }
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "workbench-ipc-"));
  initDb(path.join(dir, "workbench.db"));
});

afterEach(() => {
  closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("chat IPC over mock Electron ipcMain", () => {
  it("initBackend registers all chat+run channels (launch wiring)", () => {
    const fake = new FakeIpcMain();
    initBackend(fake);
    const expected = [...CHAT_CHANNELS, ...RUN_CHANNELS, ...WORKSPACE_CHANNELS, ...KB_CHANNELS, ...ONBOARDING_CHANNELS].filter(
      (channel) =>
        channel !== IPC_RUN.RUN_EVENT &&
        channel !== IPC_RUN.OPEN_ARTIFACT &&
        channel !== IPC_RUN.SAVE_ARTIFACT &&
        channel !== IPC_WORKSPACE.WORKSPACE_EVENT,
    );
    expect([...fake.handlers.keys()].sort()).toEqual(expected.sort());
    expect(CHAT_CHANNELS).toHaveLength(9);
    expect(RUN_CHANNELS).toHaveLength(14);
    expect(WORKSPACE_CHANNELS).toHaveLength(9);
    expect(KB_CHANNELS).toHaveLength(6);
    expect(ONBOARDING_CHANNELS).toHaveLength(4);
  });




  it("exposes host execution diagnostics through the preload IPC channel", async () => {
    const fake = new FakeIpcMain();
    initBackend(fake);
    const status = await fake.invoke(IPC_RUN.GET_EXECUTION_CAPABILITIES, undefined) as import("../src/shared/contracts.js").ExecutionCapabilities;
    expect(status.platform).toBe(process.platform);
    expect(["os_isolated", "unavailable"]).toContain(status.workspaceCommands.status);
    expect(["os_isolated", "approval_required", "unavailable"]).toContain(status.python.status);
    expect(status.workspaceCommands.message).toBeTruthy(); expect(status.python.message).toBeTruthy();
  });

  it("createChat → getChatHistory round-trips a uuid4 chat", async () => {
    const fake = new FakeIpcMain();
    registerChatHandlers(fake);
    const created = (await fake.invoke(IPC_CHAT.CREATE_CHAT, {
      title: "E-201 approval note",
    })) as { chatId: string };
    expect(created.chatId).toMatch(UUID4);
    const history = (await fake.invoke(IPC_CHAT.GET_CHAT_HISTORY, {})) as {
      chats: { id: string; title: string }[];
    };
    expect(history.chats.map((c) => c.id)).toContain(created.chatId);
  });

  it("sendMessage x2 → getMessages ordered seq 0,1; editMessage persists", async () => {
    const fake = new FakeIpcMain();
    registerChatHandlers(fake);
    const { chatId } = (await fake.invoke(IPC_CHAT.CREATE_CHAT, {})) as { chatId: string };
    const m1 = (await fake.invoke(IPC_CHAT.SEND_MESSAGE, {
      chatId,
      role: "user",
      content: "Draft the approval note",
    })) as { messageId: string; seq: number };
    const m2 = (await fake.invoke(IPC_CHAT.SEND_MESSAGE, {
      chatId,
      role: "assistant",
      content: "On it",
    })) as { messageId: string; seq: number };
    expect([m1.seq, m2.seq]).toEqual([0, 1]);
    expect(m1.messageId).toMatch(UUID4);
    await fake.invoke(IPC_CHAT.EDIT_MESSAGE, { messageId: m1.messageId, content: "Draft it now" });
    const { messages } = (await fake.invoke(IPC_CHAT.GET_MESSAGES, { chatId })) as {
      messages: { content: string; seq: number }[];
    };
    expect(messages.map((m) => m.content)).toEqual(["Draft it now", "On it"]);
  });

  it("settings round-trip via IPC; missing key returns null", async () => {
    const fake = new FakeIpcMain();
    registerChatHandlers(fake);
    await fake.invoke(IPC_CHAT.SET_SETTING, { key: "temperature", value: 0.7 });
    const got = (await fake.invoke(IPC_CHAT.GET_SETTING, { key: "temperature" })) as {
      value: unknown;
    };
    expect(got.value).toBe(0.7);
    const missing = (await fake.invoke(IPC_CHAT.GET_SETTING, { key: "nope" })) as {
      value: unknown;
    };
    expect(missing.value).toBeNull();
  });

  it("archiveChat drops the chat from history", async () => {
    const fake = new FakeIpcMain();
    registerChatHandlers(fake);
    const { chatId } = (await fake.invoke(IPC_CHAT.CREATE_CHAT, { title: "old" })) as {
      chatId: string;
    };
    await fake.invoke(IPC_CHAT.ARCHIVE_CHAT, { chatId });
    const history = (await fake.invoke(IPC_CHAT.GET_CHAT_HISTORY, {})) as {
      chats: { id: string }[];
    };
    expect(history.chats.map((c) => c.id)).not.toContain(chatId);
  });

  it("renameChat persists the new title in history", async () => {
    const fake = new FakeIpcMain();
    registerChatHandlers(fake);
    const { chatId } = (await fake.invoke(IPC_CHAT.CREATE_CHAT, { title: "old" })) as {
      chatId: string;
    };
    await fake.invoke(IPC_CHAT.RENAME_CHAT, { chatId, title: "  E-201 approval note  " });
    const history = (await fake.invoke(IPC_CHAT.GET_CHAT_HISTORY, {})) as {
      chats: { id: string; title: string }[];
    };
    expect(history.chats.find((c) => c.id === chatId)?.title).toBe("E-201 approval note");
    await expect(fake.invoke(IPC_CHAT.RENAME_CHAT, { chatId, title: "   " })).rejects.toThrow();
    await expect(fake.invoke(IPC_CHAT.RENAME_CHAT, { chatId: "not-a-uuid", title: "x" })).rejects.toThrow();
  });

  it("rejects bad uuid, oversized content, and secret-like setting keys", async () => {
    const fake = new FakeIpcMain();
    registerChatHandlers(fake);
    await expect(fake.invoke(IPC_CHAT.GET_MESSAGES, { chatId: "not-a-uuid" })).rejects.toThrow();
    const { chatId } = (await fake.invoke(IPC_CHAT.CREATE_CHAT, {})) as { chatId: string };
    await expect(
      fake.invoke(IPC_CHAT.SEND_MESSAGE, {
        chatId,
        role: "user",
        content: "x".repeat(32 * 1024 + 1),
      }),
    ).rejects.toThrow();
    await expect(
      fake.invoke(IPC_CHAT.SET_SETTING, { key: "API_KEY", value: "sk-..." }),
    ).rejects.toThrow();

    await expect(
      fake.invoke(IPC_CHAT.EDIT_MESSAGE, { messageId: "bad", content: "x" }),
    ).rejects.toThrow();
  });
});
