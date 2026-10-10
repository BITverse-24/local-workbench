# Manual UI checks

Date: 2026-10-11. The unsigned macOS arm64 package ran against the local Qwen2.5 model. The app was relaunched directly with a verified temporary user-data directory. Full run IDs, states, mode versions, artifact digest and approval outcomes are in `manual-ui-checks.json`.

## Results

- Chat and Work selection worked. Agent stayed disabled until a workspace was bound.
- Chat returned the requested answer in one recorded model call. Switching chats kept the active run with its original chat.
- Work ran in another chat. A second Chat request showed the queued status while the model was busy. Stopping that request recorded Cancelled without replacing the Work run.
- Work saved the requested 28 byte Markdown file. Its saved digest matched SQLite. The UI and database retained Partial because acceptance evidence was unverified.
- After restart, all three test chats and the saved Work artifact/state returned. The UI offered Resume from saved evidence. No resume was started.
- Agent became available with a temporary workspace. The model proposed two out-of-scope DOCX-generation actions, including in a fresh conversation. Both approval screens named the extra action. Rejecting each plan cancelled its run; the workspace file stayed `BEFORE` and no other file appeared. The approval gate worked. Agent planning quality needs follow-up.

## Limits and incident

The active-generation Stop button and Python fallback approval modal were not separately tested. The queued request and pending-plan cancellation paths were tested.

During the first restart, macOS opened another app process without the temporary profile argument and touched the default `workbench.db`. I submitted no prompt to that process and read no chat content. I quit it, then restarted by calling the app executable directly with the temporary profile. No before-run snapshot exists, so I cannot confirm the default database's earlier state. All checks reported above used the isolated profile.

The temporary profile and workspace remain under `/tmp/workbench-ui-check.czoQPm` and `/tmp/workbench-ui-agent-workspace.4QWHyb` for inspection.
