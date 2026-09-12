# Sovereign Workbench Repository Migration

> Implementation handoff for a coding agent or parallel agent fleet. This document describes the migration only; it does not authorize model-server implementation, GPU provisioning, or unrelated product work.

## 1. Objective

Refactor the repository into one coherent application with these boundaries:

    /
    ├── ai/
    │   ├── vision/
    │   ├── draft/
    │   ├── code/
    │   ├── tools/
    │   └── shared/
    ├── backend/
    ├── electron/
    ├── frontend/
    ├── config/
    ├── docs/
    ├── demo-fixtures/
    ├── package.json
    ├── package-lock.json
    ├── tsconfig.json
    ├── .env.example
    └── MIGRATION.md

The migration must:

- keep Electron as the privileged desktop shell;
- keep framework-agnostic application logic in /backend;
- move the renderer into /frontend;
- run /frontend as a separate Vite process during development;
- have Electron spawn and manage that process;
- bundle the built frontend into Electron for packaging;
- define /ai as future standalone model-service boundaries;
- call models over HTTP rather than importing model implementations into the backend;
- consolidate JavaScript dependencies into one root manifest and lockfile;
- consolidate development configuration into one root .env;
- remove active RAG;
- defer Flow A;
- preserve Flow B;
- leave model-server/GPU implementation to a later task.

## 2. Authoritative decisions

### Repository boundaries

- /electron: Electron-specific code only.
- /backend: framework-agnostic application/core logic.
- /frontend: React/Vite renderer.
- /ai/vision, /ai/draft, /ai/code: future standalone model services.
- /ai/tools: shared model-side helpers and schemas.
- /ai/shared: AI-wide types and service-boundary definitions.
- One root package.json and one root lockfile.

The backend must not import Electron. Electron may import and compose backend ports and adapters.

### Frontend development and packaging

Electron starts Vite in /frontend, waits for readiness, and loads its localhost URL. The normal root dev command starts Electron and Electron owns the Vite child-process lifecycle. A URL override may exist for debugging.

Packaging must build /frontend, include static output in the Electron bundle, load local assets with loadFile or equivalent, and require no Vite process, source repository, or .env.

### Environment

Support exactly one untracked development file: /.env. Commit only /.env.example with names/placeholders and no credentials. Remove backend/frontend/electron-specific env files and multi-location env discovery. No env file is packaged.

### Model services

Do not implement model servers, model weights, GPU startup, or process supervisors. Each model directory must document service purpose, expected identity, health endpoint, request/response boundary, configuration, error behavior, and deployment assumptions. The backend calls future model processes through HTTP adapter ports.

### RAG and grounding

Remove active Chroma, embeddings, embedding clients, search_knowledge, retrieval orchestration/contracts, citation validation/persistence, citation prompts, RAG artifact checks, and RAG acceptance tests.

Historical migration archive material was retired; active demonstration fixtures and governing criteria live under `demo/flow_a/`.

Introduce only a neutral future seam:

    export interface GroundingProvider {
      prepare(input: GroundingRequest): Promise<GroundingResult>;
    }

The seam must not mention Chroma, embeddings, vector dimensions, retrieval scores, RetrievedKnowledgeChunk, or RAG terminology.

### Flow scope

Flow A is deferred. Do not make scanned-report-to-approval-note part of migrated MVP acceptance. Preserve future vision/draft boundaries only where useful, but remove the current retrieval/citation-dependent orchestration.

Flow B remains active:

    CSV input
    → automatic code routing
    → code generation
    → user confirmation
    → sandboxed Python execution
    → verified result
    → optional XLSX artifact
    → final summary

## 3. Current repository facts and problems

Current roots are /backend with its own package, /electron_app with Electron and renderer code and its own package, and /ai with contracts, validators, prompts, registry, and mocks.

Known problems:

- two package manifests and lockfiles;
- Electron code in /electron_app;
- backend imported directly from Electron source;
- backend-specific multi-location env lookup;
- shared/unowned AI files;
- duplicated model registries;
- Chroma/RAG runtime;
- Flow A tightly coupled to retrieval/citations;
- RAG fixtures/docs treated as active acceptance;
- stale proposal/phase files;
- cwd, APP_ROOT, and relative-path assumptions;
- packaging/resource handling tied to /electron_app.

## 4. Target architecture

### Electron

Electron owns app.whenReady, BrowserWindow, development frontend startup/shutdown, packaged frontend loading, preload, IPC adapter construction, safe shell/open-artifact operations, lifecycle, packaged paths, and development diagnostics.

It must not own model routing, model-specific prompt logic, persistence queries, run transitions, tool policy, Python policy, or business rules.

### Backend

Backend owns run orchestration, deterministic routing, model HTTP ports/adapters, contracts, validation, confirmation state, run/filesystem isolation, Python execution, artifacts, persistence, health, audit events, and the future grounding port.

It must not import app, BrowserWindow, ipcMain, or ipcRenderer from Electron.

Recommended conceptual structure:

    backend/
    ├── src/
    │   ├── contracts/
    │   ├── orchestration/
    │   ├── models/
    │   ├── routing/
    │   ├── tools/
    │   ├── persistence/
    │   ├── filesystem/
    │   ├── confirmation/
    │   ├── artifacts/
    │   ├── execution/
    │   ├── grounding/
    │   ├── adapters/
    │   └── index.ts
    └── tests/

### Frontend

Frontend owns React UI/state, file drop, transcript, confirmations, artifacts, health/status, routing badges, and typed preload calls. It must not import Node filesystem APIs, Electron, model clients, backend implementation files, SQLite, child processes, credentials, or model URLs.

### AI

Use or recreate:

    ai/
    ├── vision/README.md, contract.ts, prompts/
    ├── draft/README.md, contract.ts, prompts/
    ├── code/README.md, contract.ts, prompts/
    ├── tools/README.md, contracts.ts
    └── shared/README.md, errors.ts, service-contract.ts, types.ts

Do not leave ai/contracts.ts as an unowned global dumping ground. AI code must not access Electron IPC, SQLite, secrets, absolute user paths, backend run directories, or privileged shell commands.

## 5. Package and TypeScript migration

Create one root package.json containing backend, Electron, React/Vite, TypeScript, test, validation, artifact, and native-module dependencies plus all scripts. Generate one root lockfile. Remove active backend/package.json, backend/package-lock.json, electron_app/package.json, and electron_app/package-lock.json only after the root graph works.

Provide root scripts equivalent to:

    dev
    dev:frontend
    dev:electron
    build
    build:frontend
    build:electron
    package
    typecheck
    test
    lint

Every script must work from repository root.

Use explicit configs for backend, Electron main/preload, frontend, AI placeholders, and tests. Use stable aliases such as @backend/*, @electron/*, @frontend/*, @ai/*, and @config/*. Do not create aliases that let frontend import privileged backend implementation.

## 6. File migration map

Move renderer files:

    electron_app/src/*              → frontend/src/*
    electron_app/public/*           → frontend/public/*
    electron_app/index.html         → frontend/index.html
    electron_app/vite.config.ts     → frontend/vite.config.ts
    electron_app/postcss.config.js  → frontend/postcss.config.js
    electron_app/tailwind.config.js → frontend/tailwind.config.js

Move Electron files:

    electron_app/electron/main.ts           → electron/main.ts
    electron_app/electron/preload.ts        → electron/preload.ts
    electron_app/electron/electron-env.d.ts → electron/electron-env.d.ts
    electron_app/electron-builder.json5     → electron/electron-builder.json5

Update all resource paths for the new root layout.

Refactor backend by capability rather than historical phase names. Remove stale .gitkeep-only directories and duplicated concepts.

Split AI files by ownership: model contracts into their model directory or ai/shared; prompts into their model directory; registry types into ai/shared or root config; runtime validation into backend/model-specific modules; mocks only into still-active tests; RAG material into archive or out of active paths.

## 7. Ports and adapters

Define:

    export interface ModelClient {
      complete(request: ModelRequest): Promise<ModelResponse>;
      health(modelId: ModelId): Promise<ModelHealth>;
    }

The adapter resolves only configured model IDs, rejects disabled/unknown models, enforces task compatibility and timeouts, normalizes HTTP errors, caps responses, validates structured results, preserves request/run IDs, keeps credentials private, and avoids full confidential prompt logging. It must not depend on OpenRouter, llama-server, MLX, or any particular provider.

Define an injectable IPC port:

    export interface IpcRegistrar {
      handle(
        channel: string,
        handler: (...args: unknown[]) => Promise<unknown> | unknown
      ): void;
      on?(channel: string, listener: (...args: unknown[]) => void): void;
    }

Electron supplies the real adapter; backend tests supply a fake.

Define injected process-runner and application-path ports. Inject data directory, config directory, packaged resources, frontend URL, artifact directory, and schema path. Do not derive critical paths from arbitrary cwd.

## 8. IPC and renderer security

Keep a typed preload bridge exposing only application methods such as:

    startRun
    registerAttachment
    confirmAction
    cancelRun
    getRunHistory
    getArtifact
    openArtifact
    getHealth
    getChatHistory
    getMessages
    sendMessage
    editMessage
    renameChat
    getSetting
    setSetting
    onRunEvent

Remove wildcard IPC, raw ipcRenderer, arbitrary renderer channel names, absolute path inputs, model endpoint data, environment values, and filesystem handles.

Attachments use backend-issued opaque tokens. Artifact references expose safe metadata/run-relative paths only; Electron resolves actual paths internally.

## 9. Environment implementation

Create root .env.example, for example:

    OPENROUTER_API_KEY=
    WORKBENCH_MODELS_PATH=
    WORKBENCH_FRONTEND_URL=

Keep only variables actually required. Load once from Electron startup and pass a validated config object to backend initialization. Remove backend/src/main/config/env.ts multi-location search, APP_ROOT env discovery, process.cwd() env scanning, and renderer secret access.

Offline/packaged mode must reject accidental cloud configuration when the shipped registry is LAN-only.

## 10. RAG removal

Remove active runtime references to:

    RAG
    Chroma
    embedding
    search_knowledge
    RetrievedKnowledgeChunk
    Citation
    citations
    knowledge corpus
    rag-corpus
    expected-retrieval
    developmentEmbeddingService
    no_knowledge_match
    unsupported_citation

Historical terms are allowed only in the archive.

Remove active contract types KnowledgeSectionReference, RetrievedKnowledgeChunk, Citation, citation-validation types, citation-specific draft fields, and retrieval-specific errors. Draft/approval-note results must not require grounding sections, source IDs, retrieved chunks, or citation lists.

Remove the active ocr_extract → search_knowledge → draft_note path. Do not replace it with a fake empty search. Deferred Flow A must be explicit/unavailable or behind a future feature boundary.

Remove citation tables, corpus metadata, retrieval columns, citation constraints, and RAG-specific seed metadata from the fresh schema. Remove chromadb and unused embedding dependencies.

Historical RAG documentation was retired during codebase migration; active fixtures and specifications live under `demo/flow_a/` and `demo/flow_c/`.

## 11. Flow B preservation

Flow B must continue to:

1. accept the fixed CSV;
2. route automatically to code;
3. emit the code routing event;
4. read file metadata through a controlled tool;
5. receive validated Python;
6. require explicit confirmation;
7. execute in the fixed sandbox;
8. provide no network access;
9. confine outputs to the run output directory;
10. treat timeout/non-zero exit as failed verification;
11. optionally generate XLSX after confirmation;
12. summarize actual execution output;
13. persist run/audit state;
14. render transcript, confirmation, result, and artifact state.

Keep:

    demo-fixtures/flow-b/reactor-temperature-log.csv
    demo-fixtures/flow-b/expected-task.py
    demo-fixtures/flow-b/expected-python-execution.json
    demo-fixtures/flow-b/expected-out-of-range-summary.json
    demo-fixtures/flow-b/expected-out-of-range-summary.csv

## 12. Flow A deferral

Document that vision and draft service boundaries remain future-ready, OCR contracts may remain only if not coupled to RAG, approval-note generation is not active acceptance, grounding will be redesigned separately, and citations/SOP retrieval are absent from the migrated MVP. Do not claim the app still delivers a cited approval note.

## 13. Database strategy

Use a fresh local database after migration. Preserve only:

- chats;
- messages;
- attachments;
- runs;
- run transitions;
- routing decisions;
- model calls;
- tool calls;
- execution results;
- confirmations;
- artifacts;
- run errors;
- settings;
- metadata/versioning.

Remove citation/retrieval tables. Initialize idempotently, use injected paths, work in development and packaged Electron, avoid writing into the bundle, and put packaged data under Electron userData.

Document a reset procedure for old development data. Do not automatically run destructive commands against broad directories.

## 14. Parallel-agent execution strategy

Parallelize only after the skeleton, root package, and shared contracts are agreed. Agents must not edit overlapping files.

### Lane A — package/repository

Create root package/lockfile/scripts/configs/aliases, consolidate dependencies, and remove old manifests after verification.

### Lane B — Electron/frontend

Move renderer and shell, implement Vite child-process lifecycle, update preload, update packaged loading, and verify dev/production paths.

### Lane C — backend boundaries

Remove Electron imports, define ports/adapters, refactor initialization, preserve IPC through injected adapters, and stabilize paths/config.

### Lane D — AI service boundaries

Reorganize /ai, separate vision/draft/code contracts, add service documentation, and add opaque backend model adapters. Do not implement servers.

### Lane E — RAG removal

Remove active RAG code/dependencies, simplify contracts/prompts/validators, update schema, archive legacy docs/fixtures, and remove RAG tests.

### Lane F — tests/verification

Update imports, add backend-without-Electron tests, bridge tests, dev launch smoke tests, packaging smoke tests, no-active-RAG checks, and Flow B verification.

The coordinator lands the package/config boundary before parallel source migration.

## 15. Test plan

### Static checks

Run equivalents of:

    rg -n "from ['\"].*electron|require\\(['\"]electron" backend
    rg -n "chromadb|Chroma|search_knowledge|RetrievedKnowledgeChunk|Citation|embedding" backend frontend electron ai config
    rg -n "OPENROUTER_API_KEY|process\\.env|\\.env" frontend
    find . -name package.json -not -path './node_modules/*'

Expected: no backend Electron imports, no active RAG imports, no frontend secrets/backend-only env access, and one active package manifest.

### Backend tests

Verify routing, Flow B, model timeout/error handling, structured validation, confirmation replay rejection, traversal rejection, attachment isolation, sandbox policy, artifact metadata, startup with fake adapters, and startup without Electron.

### Frontend tests

Verify preload methods, startup, file drop, routing, confirmations, artifacts, error/cancelled/completed states, and absence of direct filesystem/model access.

### Development launch

Verify root dev starts Electron, Electron starts Vite, Vite becomes ready, Electron loads the URL, renderer uses the bridge, closing Electron terminates Vite, and startup failure is visibly cleaned up.

### Packaging

Verify frontend build, Electron package, local packaged asset loading, no Vite requirement, no .env inclusion, correct model/resource/schema resolution, and data writes outside the application bundle.

### Flow B acceptance

Verify:

    routing task = code
    exit code = 0
    stdout contains OUT_OF_RANGE 7/240 (high=5, low=2)
    seven expected rows are produced
    XLSX output is valid
    confirmation is audited
    run reaches completed

Also verify unavailable model, malformed response, unsafe code, confirmation rejection/expiry, timeout, non-zero exit, and output traversal.

## 16. Completion checklist

- [ ] Root MIGRATION.md exists with this handoff.
- [ ] /electron, /backend, /frontend, and /ai boundaries exist.
- [ ] One root package manifest and lockfile are active.
- [ ] Old independent manifests and lockfiles are removed.
- [ ] Electron is the only directory importing Electron APIs.
- [ ] Backend is independently testable.
- [ ] Frontend runs separately under Vite in development.
- [ ] Electron manages the frontend process.
- [ ] Packaged Electron bundles frontend output.
- [ ] One root development .env is supported.
- [ ] No env file is packaged.
- [ ] Model directories are standalone-service boundaries.
- [ ] Backend calls models through HTTP adapters.
- [ ] No model server was implemented prematurely.
- [ ] Active RAG runtime is removed.
- [ ] Legacy RAG material is archived and non-runtime.
- [ ] Flow A is explicitly deferred.
- [ ] Flow B remains functional.
- [ ] Fresh DB initialization works.
- [ ] Old development DB data is intentionally not migrated.
- [ ] Typechecking passes.
- [ ] Tests pass.
- [ ] Development launch passes.
- [ ] Packaging smoke test passes.
- [ ] No credentials or absolute paths cross into the renderer.

## 17. Rollback and safety

Before migration:

- record git status;
- create a branch using the repository's normal codex/ prefix;
- preserve unrelated user changes;
- do not use destructive resets;
- do not delete old files until replacements compile or are intentionally archived;
- keep generated files within the selected writable repository root;
- do not modify external directories.

If a required change is outside the selected writable root, do not modify it directly. Add a concrete proposal to that directory's PROPOSALS.md only.

