# PROPOSALS — backend follow-ups found while wiring electron_app/

> **STATUS (2026-09-06): P-B1 IMPLEMENTED** in `backend/` ("save the renamed chat in
> database" task): `renameChat(id, title)` DAO in `persistence/chats.ts`,
> `workbench:renameChat` in `IPC_CHAT` + `renameChatSchema` + `handleRenameChat`,
> registered in `registerChatHandlers`; covered by `tests/ipc.test.ts` rename round-trip
> (15/15 green with `db.test.ts`). P-B2 below is still open.

> From: frontend lane ("change frontend according to backend"). Writable dir for that task
> was `electron_app/` only, so these `backend/` changes are proposed, not applied.
> Context: `electron_app/electron/main.ts` now imports `backend/src/main/index.ts`
> (`initBackend`) and bundles backend TS source into `dist-electron/main.js` with
> `better-sqlite3` external. Both workarounds below would remove frontend-side hacks.

## P-B1 — Add `renameChat` IPC channel (sidebar rename is local-only)

* **Target:** `backend/src/main/ipc/channels.ts`, `validators.ts`, `handlers.ts`,
  `backend/src/main/persistence/chats.ts`, `backend/tests/ipc.test.ts`
* **Issue:** The sidebar rename UI (`electron_app/src/components/LeftSidebar.tsx`, `renames`
  override map) cannot persist: no channel updates `chats.title`, so renames are lost on
  restart while every other chat operation survives.
* **Evidence:** `IPC_CHAT` in `backend/src/main/ipc/channels.ts:1` has 8 channels, none
  mutating `chats.title`; `LeftSidebar.tsx` carries a comment pointing here.
* **Suggested change:** `workbench:renameChat` with `{ chatId: uuid, title: 1..200 chars }`,
  `UPDATE chats SET title=?, updated_at=? WHERE id=?`; register in `registerChatHandlers`;
  cover with an `ipc.test.ts` case (rename → `getChatHistory` shows new title → relaunch
  keeps it). Frontend will then replace the override map with one invoke.
* **Reason:** Last non-persisted chat mutation in the DB slice; required for "restart
  restores everything" to hold.
* **Impact:** Additive channel, no collision with Phase 1 run-protocol names. Small.

## P-B2 — `WORKBENCH_SCHEMA_PATH` env override (+ packaged-app schema shipping)

* **Target:** `backend/src/main/persistence/db.ts` (`findSchemaPath`)
* **Issue:** `findSchemaPath` only checks (1) next-to-running-file and (2)
  `<BACKEND_ROOT>/src/main/persistence/schema.sql`, where `BACKEND_ROOT` derives from the
  backend source layout. Any consumer that bundles backend code elsewhere (Electron main
  today, future workers) must copy `schema.sql` next to its bundle — which is what
  `electron_app/vite.config.ts` (`copyBackendSchema`) does. It works but is fragile, and
  the packaged-app path (Phase 15) has no story yet.
* **Evidence:** `backend/src/main/persistence/db.ts` `findSchemaPath`; dev launch currently
  depends on the vite copy plugin; `app.isPackaged` DB goes to `userData` with no
  `schema.sql` next to it.
* **Suggested change:** Honor `WORKBENCH_SCHEMA_PATH` (explicit file) in `findSchemaPath`
  before the two derived candidates, keep the candidates as fallback; document both
  `WORKBENCH_DB_PATH` and `WORKBENCH_SCHEMA_PATH` in `backend/DATABASE.md` §0; in Phase 15,
  ship `schema.sql` via electron-builder `extraResources` and set the env in main.ts.
* **Reason:** Makes backend embeddable without per-consumer copy hacks; one env var
  instead of build-plugin coupling.
* **Impact:** Backward compatible (fallback order preserved). Lets the frontend drop its
  copy plugin. Needed before installer packaging in any case.
