import type { IpcRegistrar } from "../../backend/src/main/ipc/handlers.js";

export class FakeIpcRegistrar implements IpcRegistrar {
  private handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`Duplicate IPC channel: ${channel}`);
    this.handlers.set(channel, listener);
  }
  async invoke<T = unknown>(channel: string, input?: unknown): Promise<T> {
    const listener = this.handlers.get(channel);
    if (!listener) throw new Error(`Unknown IPC channel: ${channel}`);
    // Electron invokes handlers with structured-cloned data.
    return structuredClone(await listener({}, structuredClone(input))) as T;
  }
  channels(): string[] { return [...this.handlers.keys()].sort(); }
}
