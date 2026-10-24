# Saved drafts, recovery, and new attempts

Each chat has its own saved prompt, attachments, and workspace-reference identity. A new chat starts with an empty draft. The initial empty view has a separate draft. The app restores the last selected chat at launch. If none is selected, it can open interrupted work from run history.

Drafts use IndexedDB in the Electron profile. Attachment bytes are saved separately from prompt metadata. Typing does not rewrite the attachments. Unreferenced draft blobs are removed in the same transaction as a saved draft change. Profile isolation remains controlled by electron/storage.ts. Clearing an Electron profile also clears its unsent drafts and pins; sent requests remain in the backend database.

The composer shows saving, saved, or failed status. A draft-read failure prevents replacement of an unread draft. Save failures retain the in-memory draft and offer Retry. History and settings failures no longer switch the app into an unsaved chat mode. New chat and archive failures preserve the current view and draft. Drafts are cleared only after a run is accepted by the backend.

Pins are saved in the current profile's local storage. A pin write failure is shown in the chat list.

## Recovery

Run snapshots include recovery information derived from the persisted execution ledger, mode, model selection, workspace, and work budget. The recovery card shows saved outputs, completed steps, remaining steps, and the next valid action. Check again refreshes this information after a model or workspace change.

Resume uses the original run ID. The backend validates the original model, workspace, input paths and digests, budget, and operation outcomes before spending a resume attempt. An uncertain mutation blocks Resume. Restart still expires approvals. No approval or mutation authority is copied from the prior execution.

Chat requests, stopped tasks without a resumable plan, and tasks with no remaining work budget can use Start new attempt when their saved request is available. A new attempt is a separate execution. It can perform the requested work again and must pass its own approval checks.

## Edit and rerun

Editing an executed user request creates a linked chat. It copies context before the selected request and verifies the saved input snapshots before returning their bytes. Later messages are excluded. Earlier result references still identify the original run and evidence. Source folder listings remain read-only evidence; folder descendants are not imported as inputs.

The revised request gets a new message ID and a new run ID. The original request, responses, outputs, verification records, and approvals stay intact. The new chat has a View original action. A failure to create or start the attempt is visible and keeps the edited text available.

New workspace references added to the revised request use the currently bound workspace. Existing selected inputs use the original saved bytes. Agent attempts require the original project folder to be active. Every new Agent run uses fresh approval checks.

The start-run contract accepts an optional userMessageId. When present, the backend checks the message's chat, role, content, and unused run association before binding it to the new run. Older callers remain supported. The legacy edit API rejects changes to an executed user request; assistant finalization can still update its own message.

## Main files

- frontend/src/lib/chat-drafts.ts: draft metadata, attachment bytes, transaction ordering, and blob cleanup.
- frontend/src/lib/hooks/useChatDraft.ts: draft ownership, saved state, read protection, and retry.
- frontend/src/components/RunRecoveryCard.tsx: saved progress and recovery actions.
- backend/src/main/run/message-attempt.ts: immutable branch creation and input verification.
- backend/src/main/run/manager.ts: request/run binding, recovery eligibility, and Resume preflight.

## Verification

Run npm run typecheck and npm test for backend checks. Run npm run test:chat-continuity for isolated Electron interface checks. This command builds the frontend and starts an Electron test window with a test bridge and a separate profile. It makes no real model calls.

The continuity checks cover separate drafts, attachment bytes after reload, pins, rapid chat switches, failed chat creation, failed draft writes, failed run starts, failed history reads, recovery after restart, failed Resume, small-window controls, and keyboard-driven Edit and rerun. Backend checks cover immutable requests, copied inputs and folder evidence, source-integrity failures, unsafe Resume denial, unspent attempts after preflight failures, work-budget limits, and saved-output verification without regeneration.
