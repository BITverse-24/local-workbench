# PROPOSALS — Electron ↔ Backend chat-persistence wiring

> **STATUS (2026-09-06): IMPLEMENTED.** P1–P3 below were applied to `electron_app/` in the
> "change frontend according to backend" task: `electron/main.ts` calls `initBackend(ipcMain)`
> with `WORKBENCH_DB_PATH` set, `electron/preload.ts` exposes the 8-method `window.workbench`
> bridge, `src/lib/workbench.ts` + `App.tsx` + `LeftSidebar.tsx` persist chats/messages/
> temperature with in-memory fallback. Verified: `npm run typecheck` clean (incl. 5
> pre-existing ref/unused-import errors fixed), `npx vite build` green, bundle keeps
> `better-sqlite3` external, `dist-electron/schema.sql` auto-copied, shipped-schema
> round-trip check passes. Remaining manual step: launch Electron GUI and restart to see
> history survive. P1–P3 kept below as record.

> From: backend lane (Phase DB connection slice). Writable dir for that task was `backend/`
> only, so these `electron_app/` changes are proposed, not applied — owner: **Ayush**.
> Backend side is done and tested: `backend/src/main/index.ts` exports `initBackend(ipcMain)`,
> channels in `backend/src/main/ipc/channels.ts` (`IPC_CHAT`), handlers + Zod validators in
> `backend/src/main/ipc/handlers.ts` + `validators.ts`. Proof: `backend/tests/ipc.test.ts`
> (6/6 green over a mock ipcMain) + `backend/tests/db.test.ts` (8/8 green).
> Scope here is **chat persistence only** (chats/messages/settings survive restart).
> Run-protocol channels (`startRun`/`confirmAction`/…) stay for Phase 1 — do NOT add them yet.

## P5 — Connect the AI run protocol through the restricted Electron bridge

* **Target:** `electron_app/electron/main.ts`, `electron_app/electron/preload.ts`,
  `electron_app/electron/electron-env.d.ts`, and the renderer run client.
* **Backend now provides:** `initBackend(ipcMain, emit?)` registers the existing chat
  channels plus `workbench:startRun`, `confirmAction`, `cancelRun`, `getArtifact`,
  `getRunHistory`, `registerAttachment`, and `getHealth`. Run events use the push-only
  `workbench:runEvent` channel and are emitted by the backend manager.
* **Main-process change:** call `initBackend(ipcMain, (event) =>
  win?.webContents.send("workbench:runEvent", event))` after the window is created or
  retain a safe callback that checks `win` before sending. Do not forward model URLs,
  absolute filesystem paths, request headers, or credentials.
* **Preload change:** remove the wildcard `ipcRenderer` exposure and expose only typed
  methods for the chat API plus `startRun`, `registerAttachment`, `confirmAction`,
  `cancelRun`, `getArtifact`, `getRunHistory`, `getHealth`, and `onRunEvent`. The
  attachment bridge must accept bytes/metadata, never an absolute path; artifacts expose
  only backend `ArtifactRef` metadata.
* **Renderer change:** use `registerAttachment` on file drop, pass the returned opaque
  token to `startRun`, render `routing`, `run_state`, tool, confirmation, error, and
  artifact events, and invoke confirmations/cancellation through the bridge. No renderer
  code may import Node, `fs`, model `fetch`, OpenRouter, Chroma, or child-process APIs.
* **Reason:** The backend integration is complete and tested independently, but the
  current renderer still exposes raw IPC and `main.ts` does not provide the event sink.
  This is the remaining Electron boundary work required for the end-to-end UI.

## P1 — Register backend handlers in Electron main

* **Target:** `electron_app/electron/main.ts` (keep `main.ts:75` window controls as-is)
* **Issue:** Backend SQLite is unreachable from the app: nothing calls `initDb()` or registers
  any `ipcMain.handle` at launch, so the DB file is never created/opened by Electron.
* **Evidence:** `electron_app/electron/main.ts:72` — `app.whenReady().then(createWindow)` with
  no backend import; `backend/src/main/index.ts:1` exports `initBackend()` waiting for a caller.
* **Suggested change:**
  1. Build backend once: `npm --prefix ../backend run build` (emits `backend/dist/`; `tsc`
     already passes clean).
  2. In `main.ts`, add at top:
     ```ts
     import { initBackend } from '../../backend/dist/src/main/index.js'
     ```
     and change launch to:
     ```ts
     app.whenReady().then(() => {
       initBackend(ipcMain) // opens backend/data/workbench.db + registers 8 workbench:* handlers
       createWindow()
     })
     ```
  3. Bundler caveat (must verify with `npm run dev`): the compiled backend does
     `import Database from "better-sqlite3"`, which resolves at runtime from
     `backend/node_modules` (Node walks up from `backend/dist/…`). If `vite-plugin-electron`
     tries to bundle it, mark it external, e.g. in `vite.config.ts` main plugin options:
     ```ts
     electron({ main: { entry: 'electron/main.ts', vite: { build: { rollupOptions: { external: ['better-sqlite3'] } } } } /* … */ })
     ```
     and confirm `backend/src/main/persistence/schema.sql` is reachable (compiled `db.js`
     falls back to `<backend>/src/main/persistence/schema.sql`; for packaged builds in
     Phase 15 this file must be shipped next to `dist` or copied over).
* **Reason:** One-line launch wiring is the entire main-process half of the connection;
  `initBackend` takes the real `ipcMain` (structural typing, no `electron` import in backend).
* **Impact:** On launch the DB file is created/migrated and all 8 chat channels start
  answering. No renderer change needed for this step. Risk: bundler/external misconfig —
  caught immediately at `npm run dev` (handler invoke would reject with MODULE_NOT_FOUND).

## P2 — Typed `window.workbench` preload bridge (chat slice)

* **Target:** `electron_app/electron/preload.ts` + `electron_app/electron/electron-env.d.ts`
* **Issue:** Renderer only has the wildcard `ipcRenderer` expose (`preload.ts:4`); there is no
  typed chat API, so `App.tsx` cannot use persistence without raw channel strings.
* **Evidence:** `preload.ts:1` exposes generic on/off/send/invoke; `App.tsx:62 handleSend`
  builds `{ id: Date.now().toString() }` in-memory messages with a hardcoded auto-reply.
* **Suggested change:** add (do NOT remove the wildcard yet — that removal is Phase 1's Done):
  ```ts
  // preload.ts
  contextBridge.exposeInMainWorld('workbench', {
    createChat: (input?: { title?: string }) => ipcRenderer.invoke('workbench:createChat', input ?? {}),
    getChatHistory: (input?: { limit?: number }) => ipcRenderer.invoke('workbench:getChatHistory', input ?? {}),
    archiveChat: (chatId: string) => ipcRenderer.invoke('workbench:archiveChat', { chatId }),
    getMessages: (chatId: string) => ipcRenderer.invoke('workbench:getMessages', { chatId }),
    sendMessage: (chatId: string, role: 'user' | 'assistant', content: string) =>
      ipcRenderer.invoke('workbench:sendMessage', { chatId, role, content }),
    editMessage: (messageId: string, content: string) =>
      ipcRenderer.invoke('workbench:editMessage', { messageId, content }),
    getSetting: (key: string) => ipcRenderer.invoke('workbench:getSetting', { key }),
    setSetting: (key: string, value: unknown) => ipcRenderer.invoke('workbench:setSetting', { key, value }),
  })
  ```
  plus `Window` augmentation in `electron-env.d.ts`:
  ```ts
  interface WorkbenchBridge {
    createChat: (input?: { title?: string }) => Promise<{ chatId: string }>;
    getChatHistory: (input?: { limit?: number }) => Promise<{ chats: { id: string; title: string; updated_at: string }[] }>;
    archiveChat: (chatId: string) => Promise<void>;
    getMessages: (chatId: string) => Promise<{ messages: { id: string; role: string; content: string; seq: number }[] }>;
    sendMessage: (chatId: string, role: 'user' | 'assistant', content: string) => Promise<{ messageId: string; seq: number }>;
    editMessage: (messageId: string, content: string) => Promise<void>;
    getSetting: (key: string) => Promise<{ value: unknown }>;
    setSetting: (key: string, value: unknown) => Promise<void>;
  }
  interface Window { workbench: WorkbenchBridge; }
  ```
* **Reason:** Gives the renderer a typed, channel-string-free API limited to the DB slice;
  channel names match `IPC_CHAT` exactly (verified in `backend/tests/ipc.test.ts`).
* **Impact:** Renderer can persist without touching SQL. Validation errors surface as invoke
  rejections (bad uuid, >32k content, secret-like setting keys) — wrap calls in try/catch.

## P3 — Persist `App.tsx` chat state via the bridge

* **Target:** `electron_app/src/App.tsx` (suggest new `electron_app/src/lib/workbench.ts` thin client)
* **Issue:** Chat state is ephemeral: `messages` useState (`App.tsx:30`), ids from `Date.now()`
  (`App.tsx:67`), and every send fabricates a placeholder assistant reply (`App.tsx:76`).
  Restart wipes everything despite the backend DB.
* **Evidence:** `App.tsx:62 handleSend`, `App.tsx:87 handleEditMessage` — pure setState, no IPC.
* **Suggested change:**
  1. On launch: `getSetting('lastChatId')` → if uuid, `getMessages` for it; else `createChat()`
     + `setSetting('lastChatId', chatId)`. Also load `getChatHistory()` for `LeftSidebar`
     (currently collapsed static) and `getSetting('temperature')` / `'selectedModel'` for
     `RightSidebar` initial state (`App.tsx:22`).
  2. `handleSend`: `await workbench.sendMessage(chatId, 'user', input)` and append the
     returned `{ messageId, seq }` instead of `Date.now()` ids; **delete the placeholder
     auto-reply** (assistant turns arrive from the orchestrator in Phase 1; until then,
     echo via a second `sendMessage(chatId, 'assistant', …)` only if a stub is needed).
  3. `handleEditMessage`: `await workbench.editMessage(id, newText)` before setState.
  4. Persist `temperature`/`selectedModel` changes with `setSetting` (keys already seeded
     with defaults server-side: `"draft-qwen3"`, `0.2`, `"dark"`, …).
* **Reason:** Makes chats/messages/settings durable — the user-visible payoff of this slice.
* **Impact:** Restart restores history; message ids become uuid4 (matches `ChatMessage.id`
  string type already). No schema or backend change required. Verify: send → restart app →
  history intact; `backend/data/workbench.db` shows rows.

## P4 — Persist sidebar rename via `workbench:renameChat` (backend ready)

> **STATUS (2026-09-06): IMPLEMENTED** in `electron_app/` ("rename reverts" fix):
> `renameChat` added to the preload bridge, `WorkbenchBridge`, `workbench.ts`, and
> `App.handleRenameChat` now persists (optimistic local update + invoke). Typecheck clean,
> `vite build` green, `renameChat` confirmed in `dist-electron/preload.mjs`.

* **Target:** `electron_app/electron/preload.ts`, `electron_app/electron/electron-env.d.ts`,
  `electron_app/src/lib/workbench.ts`, `electron_app/src/App.tsx`
* **Issue:** `LeftSidebar` rename calls `onRename`, but `App.handleRenameChat` only updates
  local history state — the new title is lost on restart. Backend P-B1 is now implemented
  (`workbench:renameChat`, 15/15 backend tests green), so only the renderer hookup is missing.
* **Evidence:** `App.tsx` `handleRenameChat` (no bridge call); preload `window.workbench`
  has 8 methods, no `renameChat`.
* **Suggested change:**
  1. `preload.ts` bridge: `renameChat: (chatId: string, title: string) =>
     ipcRenderer.invoke('workbench:renameChat', { chatId, title })`.
  2. `electron-env.d.ts` `WorkbenchBridge`: `renameChat: (chatId: string, title: string) => Promise<void>`.
  3. `src/lib/workbench.ts`: `export async function renameChat(chatId: string, title: string): Promise<void>`.
  4. `App.tsx handleRenameChat`: keep the optimistic `setHistory` update, then
     `if (persistent && !id.startsWith('local-')) { try { await wb.renameChat(id, title); } catch { setPersistent(false); } }`.
* **Reason:** Last non-persisted chat mutation; makes "restart restores everything" hold.
* **Impact:** Rename survives restart (title + bumped `updated_at` re-sorts history).
  Validation errors (bad uuid, empty/>200-char title) surface as invoke rejections.

## P6 — Image-only sends fail persisting the user message (empty `content`)

* **Target:** `electron_app/src/App.tsx` `handleSend` (~line 373)
* **Issue:** Attaching an image with an empty composer still calls
  `wb.sendMessage(cid, "user", "")`, and backend `sendMessageSchema` requires
  `content` min(1). The send fails immediately with the cryptic
  `String must contain at least 1 character(s)` before the run even starts.
* **Evidence:** `App.tsx:353-356` allows send when `hasFiles` alone;
  `App.tsx:373` persists raw `text` (possibly `""`);
  `backend/src/main/ipc/validators.ts` `sendMessageSchema` (`content` min(1),
  32k max). Backend side intentionally unchanged — empty persisted messages
  stay invalid.
* **Suggested change:** persist a label when the composer is empty, e.g.
  ```ts
  const label = text.trim() ? text : `[attached ${file.name}]`;
  const { messageId } = await wb.sendMessage(cid, "user", label);
  ```
  and keep passing raw `text` (possibly `""`) as `startRun.userText` — the
  backend now accepts empty text when `attachmentToken` is present
  (`startRunSchema` refine + `RunManager.start` guard; vision flows use the
  fixed `ai/` extraction prompt and ignore the text anyway).
* **Reason:** The chat transcript should show *something* for an image-only
  turn, and the run path already handles it.
* **Impact:** Image-only sends persist + run instead of failing at step one.
  No backend change needed (already done and tested).
