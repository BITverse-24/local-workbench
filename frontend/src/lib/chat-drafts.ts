export interface ChatDraft {
  text: string;
  files: File[];
  workspace: WorkspaceInfo | null;
}

interface SavedFile { id: string; name: string; type: string; lastModified: number }
interface SavedDraft { text: string; files: SavedFile[]; workspace: WorkspaceInfo | null }
export const emptyDraft = (): ChatDraft => ({ text: "", files: [], workspace: null });
export const draftKey = (chatId: string | null) => chatId ?? "new-chat";

/** Keep file bytes separate: typing saves small metadata, without rewriting attachments. */
export class ChatDraftStore {
  private database?: Promise<IDBDatabase>;
  private pending = new Map<string, Promise<void>>();
  private fileIds = new WeakMap<File, string>();
  private storedIds = new Set<string>();

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("workbench-chat-drafts", 2);
        request.onupgradeneeded = () => {
          for (const name of ["drafts", "files"]) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); this.database = undefined; this.storedIds.clear(); };
          resolve(request.result);
        };
        request.onerror = () => reject(request.error ?? new Error("Draft storage could not be opened."));
        request.onblocked = () => reject(new Error("Close other Workbench windows to restore draft storage."));
      }).catch(error => { this.database = undefined; throw error; });
    }
    return this.database;
  }

  async load(key: string): Promise<ChatDraft> {
    await this.pending.get(key)?.catch(() => undefined);
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["drafts", "files"], "readonly");
      const request = transaction.objectStore("drafts").get(key);
      let result = emptyDraft();
      let failure: Error | undefined;
      request.onsuccess = () => {
        const saved = request.result as SavedDraft | undefined;
        if (!saved) return;
        result = { text: saved.text, workspace: saved.workspace, files: [] };
        saved.files.forEach((ref, index) => {
          // Preserve drafts from the initial format if this store is upgraded.
          if (ref instanceof File) { result.files[index] = ref; return; }
          const fileRequest = transaction.objectStore("files").get(ref.id);
          fileRequest.onsuccess = () => {
            if (!(fileRequest.result instanceof Blob)) { failure = new Error(`Saved attachment is missing: ${ref.name}`); transaction.abort(); return; }
            const file = new File([fileRequest.result], ref.name, { type: ref.type, lastModified: ref.lastModified });
            this.fileIds.set(file, ref.id); this.storedIds.add(ref.id); result.files[index] = file;
          };
        });
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Saved draft could not be read."));
    });
  }

  save(key: string, draft: ChatDraft): Promise<void> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const db = await this.open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(["drafts", "files"], "readwrite");
        const store = transaction.objectStore("drafts"), files = transaction.objectStore("files");
        const written: string[] = [];
        const refs = draft.files.map(file => {
          let id = this.fileIds.get(file);
          if (!id) { id = crypto.randomUUID(); this.fileIds.set(file, id); }
          if (!this.storedIds.has(id)) { files.put(file, id); written.push(id); }
          return { id, name: file.name, type: file.type, lastModified: file.lastModified };
        });
        if (!draft.text && !draft.files.length) store.delete(key);
        else store.put({ text: draft.text, workspace: draft.workspace, files: refs } satisfies SavedDraft, key);
        // Remove only blobs no draft references, including drafts moved to a new chat.
        const allDrafts = store.getAll();
        allDrafts.onsuccess = () => {
          const referenced = new Set((allDrafts.result as SavedDraft[]).flatMap(item => item.files.map(file => file.id)));
          const keys = files.getAllKeys();
          keys.onsuccess = () => {
            for (const id of keys.result) if (!referenced.has(String(id))) { files.delete(id); this.storedIds.delete(String(id)); }
          };
        };
        transaction.oncomplete = () => { for (const id of written) this.storedIds.add(id); resolve(); };
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("Draft could not be saved."));
      });
    });
    this.pending.set(key, next);
    void next.finally(() => { if (this.pending.get(key) === next) this.pending.delete(key); }).catch(() => undefined);
    return next;
  }
}
