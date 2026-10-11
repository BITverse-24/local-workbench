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

## Safety notes

- Chat and Work do not receive workspace mutation tools.
- Agent operations are bound to the selected workspace. The app checks file paths and requires approval for protected actions.
- Command execution requires available operating-system isolation. It stops if the required isolation cannot start.
- Python can use an explicitly approved fallback when operating-system isolation is unavailable. That fallback does not provide filesystem or network isolation. The approval is tied to the code and inputs.
- Work files are stored under the run data folder. Use the app’s save action to copy an artifact elsewhere.

Review the safety model for your environment before using the app with sensitive data. Local or private model endpoints and local storage do not by themselves provide a full network or operating-system security boundary.

## Example workflows

The [`demo/`](demo/) folder contains sample inspection, data repair, and drawing review workflows. The fixtures are examples for development and evaluation; they are not required for normal app use.

## Releases

Published installers and their platform notes belong on [GitHub Releases](https://github.com/BITverse-24/agent/releases), not in the source tree. This repository’s `release/` folder is ignored build output.

## License

This project is licensed under the [MIT License](LICENSE).
