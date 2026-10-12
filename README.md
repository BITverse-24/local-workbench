# Local Workbench

Local Workbench is a local-first desktop app for asking questions about files, creating work products, and making approved changes in a selected workspace.

## Project team

| Team | Team ID |
| --- | ---: |
| **Unpaid_Interns** | **119100** |

[![Documentation](https://img.shields.io/badge/Documentation-project%20docs-1f2937?style=flat-square)](docs/diagrams/00_ARCHITECTURE_AUDIT.md)
[![Release](https://img.shields.io/badge/Release-v0.1.0-1f2937?style=flat-square)](VERSION)
[![License: MIT](https://img.shields.io/badge/License-MIT-1f2937?style=flat-square)](LICENSE)

## What it does

The app connects to a model server that you run on your computer or private network. It does not require a cloud model service. You set the model endpoints during onboarding.

The app supports three modes:

| Mode | Use it for | Access |
| --- | --- | --- |
| **Chat** | Questions and follow-up discussion | Authorized attachments, prior results, and knowledge sources that you enable. No workspace tools. |
| **Work** | Analysis, calculations, and requested files | Run-scoped inputs and outputs. Results are checked before delivery. |
| **Agent** | Work in a selected project folder | Workspace tools with path checks, approval gates, mutation records, and backups. |

The onboarding page supports model endpoints at `localhost`, loopback addresses, private IPv4 ranges (`10/8`, `172.16/12`, `192.168/16`), and local IPv6 ranges. Public IP addresses and public host names are rejected. A private-network endpoint can send data over your LAN. This endpoint rule is not an operating-system firewall and does not make a network air-gapped.

Draft is the default choice in the model selector. Vision, Coding, Draft, and Embeddings can use separate endpoints. The app combines duplicate model endpoints in the selector.

## Main components

Chat names update after the first message. The app saves a short fallback title, then asks the local model for a topic title after the run ends. A manual name takes priority.

With a workspace open, type `@` in the prompt to select a file or folder. Use the arrow keys and Enter or Tab to select a suggestion. Use Escape to close the list. File mentions supply saved source copies. Folder mentions supply paths only. Chat and Work receive no workspace tool access from these mentions.

The side panels adjust to the window width. Settings uses a drawer below 1280 pixels. Explorer also uses a drawer below 960 pixels. Use the header buttons to open either panel.

To check the chat interface, first run `npm run build`. Then run `env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron scripts/test-chat-ux.cjs` on macOS or Linux. On Windows, clear `ELECTRON_RUN_AS_NODE` and run the Electron executable with the same script. The check uses a test bridge and writes screenshots to the system temporary folder.

```text
React renderer
    │ typed Electron IPC
Electron main process
    │
RunManager ── ChatResponder
    │        ├ WorkOrchestrator
    │        └ AgentLoop ── workspace tools
    │
ModelGateway ── local or private-network model server
    ├ SQLite run and chat data
    ├ run-scoped files and results
    └ local document search
```

The backend and renderer run inside Electron. SQLite, run files, and the knowledge index are stored on the local machine. See [AGENTS.md](AGENTS.md) for the code map and execution details. Other design notes are in [`docs/diagrams/`](docs/diagrams/), and persistence and streaming notes are in [`backend/`](backend/).

## Setup for development

### Requirements

- Node.js 22.12 or later
- npm 10 or later
- An OpenAI-compatible local model server, such as Ollama, LM Studio, vLLM, or `llama-server`

Start the model server before testing a model connection. Configure its model name, host, and port in the onboarding screen.

### Install, run, and check

```bash
npm ci
npm run dev
```

Run the checks and build with:

```bash
npm run typecheck
npm test
npm run build
```

Create a desktop package for the current build host with:

```bash
npm run package
```

The packaging configuration defines a macOS DMG, a Windows x64 installer, and a Linux AppImage. Build and test each target on its supported platform. Check the release notes for the platforms and signing status of published binaries.

Use root `icon.png` as the icon source. Run `npm run build:icons` to update the app icons, or run the normal build or package command. The build trims clear margins, keeps the logo's proportions, and preserves transparency. Final files are `build/icons/icon.icns` for macOS, `build/icons/icon.ico` for Windows, and `build/icons/icon.png` for Linux. The frontend copy is updated at the same time. The small icon variants are generated in a temporary folder and removed after conversion.

The macOS package step also applies a custom file icon to the app bundle. This preserves the transparent logo in Finder on macOS Tahoe, which can place a gray tile behind the standard app icon. This step uses Swift from the Xcode command line tools. The DMG must preserve the custom icon's file metadata when the app is copied. Verify the icon in Finder after packaging or installing; PNG transparency alone does not verify the displayed app icon.

Development, preview, and release use separate storage. Development keeps backend data in the repository's `data/` folder. Preview and release keep their databases, run files, model settings, and knowledge indexes under `<appData>/local-workbench/preview/` and `<appData>/local-workbench/production/`. Each mode also has its own Electron browser profile. On macOS, `<appData>` is `~/Library/Application Support`; Windows uses `%APPDATA%`; Linux uses `$XDG_CONFIG_HOME` or `~/.config`.

Preview and release start with empty model settings and require onboarding. They ignore development model and database path overrides. Packages do not include the development model registry. The old shared profile stays on disk for recovery; the app does not import it into release storage.

## Execution support by platform

The Work and Agent mode selector shows the current execution status. Use **Refresh** in Service health after you install Python or change the host isolation settings. The app probes the same isolation launcher used for execution. Commands also probe isolation again before they copy inputs or execute user code.

| Platform | Agent workspace commands | Python in run storage |
| --- | --- | --- |
| Windows | Uses `cmd.exe` after exact command approval. No OS isolation backend is available. | Python 3 is required. Execution requires separate approval and has no OS filesystem or network isolation. |
| Linux | Uses bubblewrap (`bwrap`) when its probe passes. Otherwise, uses `/bin/sh` after exact command approval. | Uses bubblewrap when its isolation probe passes. Otherwise, execution requires separate approval and has no OS filesystem or network isolation. |
| macOS | Uses `sandbox-exec` when its probe passes. Otherwise, uses `/bin/sh` after exact command approval. | Uses `sandbox-exec` when its isolation probe passes. Otherwise, execution requires separate approval and has no OS filesystem or network isolation. |

On Linux, install your distribution's **bubblewrap** package. The AppImage does not include it. The app checks `/usr/bin/bwrap`, `/bin/bwrap`, and PATH. The host must permit user namespaces and the namespaces required by bubblewrap. A package can be present while host security settings prevent it from starting. Check the displayed probe diagnostic and your distribution's namespace policy. If isolation cannot start, commands can still run after approval. The approval covers the exact command and run, and states that execution can use your permissions to access files and the network. A failed user command is never retried without isolation.

Python discovery uses `PYTHON`, if set, or PATH. Set `PYTHON` to an absolute interpreter path or an interpreter name on PATH. On Windows, the app checks both `python.exe` and `python3.exe`. Every launch uses the exact resolved interpreter. The run environment excludes user Python packages and does not inherit the full application environment.

Approval for Python without OS isolation covers the run, exact source, generated Python dependencies, and staged inputs by digest. The app checks these bytes after approval and before execution. A change requires a new approval. This fallback runs with your user permissions and can access files and the network. It is not a sandbox.

Commands run in an independent workspace copy. The app checks changes from this copy against the approved paths, rejects links, and publishes successful changes with backups. These checks do not contain a process that runs without OS isolation. In fallback mode, absolute paths can access the original workspace or other files, and those effects cannot be rolled back by the copy. The UI and command transcript show the actual isolation status. Use Windows `cmd.exe` syntax on Windows and `/bin/sh` syntax on Linux or macOS; structured Python checks use the detected interpreter on Windows.

Tool results sync payload files before saving a SQLite manifest. Windows syncs the published file with a writable handle; it does not attempt an unsupported directory sync. Unix systems also sync the containing directory. Payload digests, immutable result IDs, and run boundaries apply on all three systems. Windows volumes without hard links use exclusive copying before the manifest commit. This strategy does not claim Unix directory-sync guarantees for sudden power loss on Windows. A real storage failure names the failed step; a read-only tool failure does not imply a workspace change.

Onboarding stores the model context window separately from the output allowance. A model on a private LAN address receives a default output allowance of one quarter of its context window when no exact endpoint profile exists. Chat also caps output at one quarter of the context window, so a saved output limit cannot consume the entire prompt budget.

## Safety notes

- Chat and Work do not receive workspace mutation tools.
- Agent operations are bound to the selected workspace. The app checks file paths and requires approval for protected actions.
- Command execution uses OS isolation when its probe passes. Otherwise, exact command approval permits execution with user permissions. The workspace copy is not an OS sandbox.
- Python can use an explicitly approved fallback when operating-system isolation is unavailable. That fallback does not provide filesystem or network isolation. The approval is tied to the code and inputs.
- Work files are stored under the run data folder. Use the app’s save action to copy an artifact elsewhere.

Review the safety model for your environment before using the app with sensitive data. Local or private model endpoints and local storage do not by themselves provide a full network or operating-system security boundary.

## Example workflows

The [`demo/`](demo/) folder contains sample inspection, data repair, and drawing review workflows. The fixtures are examples for development and evaluation; they are not required for normal app use.

## Releases

Published installers and their platform notes belong on [GitHub Releases](https://github.com/BITverse-24/agent/releases), not in the source tree. This repository’s `release/` folder is ignored build output.

## License

This project is licensed under the [MIT License](LICENSE).

## Native portability checks

The `Native package portability` workflow builds an unpacked package on Windows, macOS, and Linux. It checks Agent file reads through result storage and retrieval, checksum integrity, database reopen, Python workspace validation, and a real manifest failure. On macOS it also forces the command fallback. To run it locally, set `WORKBENCH_BUILD_SMOKE=1`, run `npm run package:dir`, then run `node scripts/test-packaged-portability.cjs`. The smoke bundle is included only when this build option is set. CI results must pass before claiming native coverage.
