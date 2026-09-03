# Sovereign Workbench MVP — Action Plan

This is the build order for the MVP described in `PRODUCT.md`, `PS.md`, and `docs/architecture/`.

Tasks with the same number can be done in parallel. The number shows the delivery sequence; the letter identifies the parallel workstream. Each top-level task has one owner and one completion condition.

## Owners

- **Ayush — Frontend:** Electron screens, file drop, live transcript, route badge, confirmations, sovereignty panel, and artifact views.
- **Supreet — Backend:** Electron main process, router, agent loop, model connections, tools, run storage, files, and packaging.
- **Sid — AI/ML:** Model setup, OCR, drafting, coding prompts, local knowledge base, fixtures, and offline demo readiness.

## Product boundaries to keep throughout

- Build the two demo flows only: scanned inspection report → cited approval note, and CSV/data task → verified Python result.
- Keep all models, retrieval, files, artifacts, and execution on the approved private LAN, with one development exception: until packaging, the three model routes point at OpenRouter through the same registry and gateway contract, and the switch back to the LAN models is a config-only change made in task 11a.
- Use three dedicated models: vision/OCR, drafting, and coding. The app chooses the model automatically.
- Demonstrate the zero-external-request sovereignty proof only in sessions against the local models; while OpenRouter is configured, the panel shows the true external count for OpenRouter calls.
- Keep the agent bounded: it plans, calls tools, observes results, and streams each step to the UI.
- Preserve the visible sovereignty proof: approved LAN allowlist, zero external requests, and one independently blocked outbound attempt.
- Keep DOCX/XLSX creation and Python execution behind explicit user confirmation.
- Use clean typed scans and fixed local demo files. Do not add handwriting OCR, authentication, PowerPoint generation, enterprise RAG, or production hardening.

## 1. Lock the demo and prepare the machines

### 1a) Lock the MVP demo requirements

**Owner:** Supreet

**Do:**

i. Write down the exact Flow A story, from dropping the inspection report to opening the approval note.

ii. Write down the exact Flow B story, from dropping the CSV to showing the verified result.

iii. Name the fixed input files, expected findings, expected SOP citation, expected code result, and required visible route changes.

iv. Mark the product features that are deliberately out of scope for this build.

**Success criteria:** Everyone is building toward the same two fixed demos, with a short list of expected screens, outputs, and evidence.

### 1b) Assign the five machines and private-LAN addresses

**Owner:** Sid

**Do:**

i. Assign the M4 Mac Mini to vision/OCR.

ii. Assign i7 #1 to drafting, i7 #2 to coding, i7 #3 to the application/RAG/sandbox, and the i5 to embeddings and the local knowledge base.

iii. Record each machine’s LAN IP, service port, startup command, and permitted peer.

iv. Configure the private-LAN allowlist for the independent network monitor/firewall.

**Success criteria:** All five machines have fixed roles and addresses, and the team knows exactly which host each part of the demo uses.

### 1c) Sketch the desktop experience

**Owner:** Ayush

**Do:**

i. Lay out the chat/input area, file-drop area, live agent transcript, routing badge, confirmation dialog, artifact preview, run status, and sovereignty panel.

ii. Decide how the user sees the two model changes in Flow A: vision first, drafting second.

iii. Decide how success, cancellation, and failure appear in both flows.

**Success criteria:** The team has a simple screen plan that lets a presenter explain the route, agent steps, confirmation, result, and zero-egress state without hidden UI.

## 2. Create the basic application and model access

### 2a) Create the application foundation

**Owner:** Supreet

**Do:**

i. Create the Electron application structure from the architecture: main process, preload, renderer, orchestrator, model gateway, tools, persistence, and artifacts.

ii. Set up the local build and start commands.

iii. Define the shared names and shapes for runs, routes, tools, confirmations, artifacts, and streamed events.

iv. Create `config/models.json` and the local `data/` directories.

**Success criteria:** The project starts locally and has the agreed places for the main process, UI, agent logic, model connections, tools, run data, and generated files.

### 2b) Connect OpenRouter for development and the local embedding service

**Owner:** Sid

**Do:**

i. Add development registry entries in `config/models.json` for vision, drafting, and coding that point at OpenRouter's OpenAI-compatible endpoint, one capable stand-in model per task type.

ii. Read the OpenRouter key from an environment variable or untracked local config; never commit it or expose it to the renderer.

iii. Confirm each of the three task types answers a simple request through the model gateway with no other code changes.

iv. Install the local embedding service and Chroma on the development host now, so the corpus, section IDs, and citations stay stable across the later model switch.

v. Record which OpenRouter model stands in for each finals model and where prompt behaviour is expected to differ.

**Success criteria:** All three task types answer through the gateway via OpenRouter with no local model setup, the embedding service and Chroma answer locally, and no API key exists in the repository.

### 2c) Build the Electron shell and restricted bridge

**Owner:** Ayush

**Do:**

i. Create the main window and renderer entry point.

ii. Add the preload bridge for starting a run, confirming an action, cancelling a run, reading history, opening an artifact, and receiving run events.

iii. Add empty states for the chat, transcript, artifact pane, confirmation dialog, and sovereignty panel.

iv. Keep filesystem, model, tool, and child-process access out of the renderer.

**Success criteria:** The desktop app opens with all main areas visible, and the renderer can communicate only through the small documented bridge.

## 3. Make the shared foundations functional

### 3a) Connect the model registry and health checks

**Owner:** Supreet

**Do:**

i. Put the three model endpoints and their task types in `config/models.json`.

ii. Make the backend choose a model only from that file.

iii. Add startup checks for the vision, drafting, coding, and embedding services.

iv. Show unavailable services in the UI before a run can start.

v. Make a failed service stop the run with a clear message; never fall back to an endpoint outside `config/models.json` or to the wrong model. During development the registry contains only the team's OpenRouter entries; no other external endpoint is ever permitted.

**Success criteria:** The app knows which local model handles each task, shows whether services are ready, and cannot call an unapproved endpoint.

### 3b) Build the small local knowledge base

**Owner:** Sid

**Do:**

i. Collect the 10–30 local documents needed for the demo, including the matching SOP and approval-note template.

ii. Give each document a stable name and section identifier.

iii. Embed and store the documents in local Chroma.

iv. Make a search for the inspection report return the expected SOP section and template.

v. Make a search with no useful match return “no matching source” so the app cannot create an uncited note.

**Success criteria:** Flow A can search the local corpus and receive the expected SOP citation while offline; the corpus is small, local, and ready before the agent is wired up.

### 3c) Connect run events to the first UI

**Owner:** Ayush

**Do:**

i. Show run state changes in the transcript.

ii. Show route changes as a badge with the task type and a short reason.

iii. Show plan steps, tool calls, tool results, confirmations, artifacts, and errors in order.

iv. Show loading, waiting, completed, cancelled, and failed states.

**Success criteria:** A local sample event stream produces a readable live transcript and routing badge, with no model address or filesystem path exposed.

## 4. Add the secure run and file flow

### 4a) Create isolated runs and safe file handling

**Owner:** Supreet

**Do:**

i. When a run starts, create `data/runs/<run-id>/input/` and `data/runs/<run-id>/output/`.

ii. Copy the dropped file into the input folder and keep the original input unchanged.

iii. Give the file an internal attachment token; pass the token rather than an absolute path to the agent.

iv. Reject unsupported or oversized files and any path outside the run folder.

v. Store the run status and important actions locally in SQLite.

**Success criteria:** A dropped file creates one isolated run, tools can use it through a token or run-relative path, and one run cannot read or overwrite another run.

### 4b) Add automatic task routing

**Owner:** Supreet

**Do:**

i. Route image/PDF report analysis to the vision model.

ii. Route requests mentioning CSV, code, scripts, calculations, execution, or data transformation to the coding model.

iii. Route other requests to the drafting model.

iv. Emit a visible routing event every time the selected model changes.

v. After Flow A extraction and retrieval, switch from vision to drafting automatically.

**Success criteria:** The user never selects a model manually; Flow A visibly uses vision then drafting, and Flow B visibly uses coding.

### 4c) Connect the real file-drop interaction

**Owner:** Ayush

**Do:**

i. Let the user drop or select the fixed inspection PDF and CSV.

ii. Send the user’s request and the internal attachment token to the backend.

iii. Show the file name and basic information without showing its absolute path.

iv. Prevent starting a run while required services are unavailable.

**Success criteria:** Both fixed files can start a real run from the desktop UI, and invalid files are rejected with a clear message.

## 5. Implement the agent’s usable tools

### 5a) Build the tool runner

**Owner:** Supreet

**Do:**

i. Implement one backend entry point for the product tools: file reading, OCR, knowledge search, note drafting, DOCX generation, code drafting, Python execution, and XLSX generation.

ii. Allow only the tools needed by the current flow.

iii. Keep tool inputs and outputs small, structured, and tied to the current run.

iv. Stop the agent after eight model/tool steps.

v. Return a visible error when a tool is unavailable, not permitted, or takes too long.

**Success criteria:** The agent can call each required tool through one controlled backend path, cannot call a tool from the wrong flow, and never runs indefinitely.

### 5b) Make OCR produce useful findings

**Owner:** Sid

**Do:**

i. Create the vision prompt for the fixed clean typed inspection report.

ii. Return the extracted text, key findings, and page references in a predictable format.

iii. Adjust the prompt until the known findings in the fixed report are consistently captured.

iv. Keep the UI wording limited to clean typed scans; do not promise general handwriting recognition.

v. After the switch to the local vision model in task 11a, re-run this check against Qwen2.5-VL and re-freeze the prompt.

**Success criteria:** The vision step returns the findings needed for the approval note, with page references, from the fixed scan.

### 5c) Make knowledge search return usable citations

**Owner:** Sid

**Do:**

i. Pass the extracted findings to local knowledge search.

ii. Return the best matching SOP/template sections with their stable IDs and short excerpts.

iii. Limit the returned sources to the small set the drafting model needs.

iv. Ensure every citation shown in the note comes from the returned sources.

**Success criteria:** Flow A receives the expected source, such as `SOP-114 §3.2`, and the system has a clear no-source outcome instead of guessing.

## 6. Build Flow A: inspection report to approval note

### 6a) Implement the Flow A agent sequence

**Owner:** Supreet

**Do:**

i. Start with the user’s report request and the attachment token.

ii. Classify and route to vision.

iii. Extract findings, search the local SOP corpus, and route to drafting.

iv. Ask the drafting model for an approval note grounded in the findings and retrieved sources.

v. Ask the user for confirmation before creating the document.

vi. After approval, create the DOCX/PDF artifact and finish the run.

**Success criteria:** The backend completes the entire Flow A sequence in the documented order, with each plan step, route, tool call, result, and confirmation streamed to the UI.

### 6b) Tune the approval-note output

**Owner:** Sid

**Do:**

i. Create the drafting prompt and note format.

ii. Include the extracted findings, the relevant SOP sections, and the required citation format.

iii. Make the prompt avoid unsupported facts and leave missing information visible.

iv. Freeze the prompt once the fixed report produces an acceptable note; after the switch to the local drafting model in task 11a, re-validate it against Qwen3 and re-freeze.

**Success criteria:** The draft contains the expected approval-note sections, uses the retrieved SOP citation, and is ready for document generation.

### 6c) Make Flow A readable in the UI

**Owner:** Ayush

**Do:**

i. Show the vision route and the reason for it.

ii. Show OCR findings and the SOP search as separate agent steps.

iii. Show the switch to drafting as a second route badge.

iv. Show the note-generation confirmation with an approve and reject action.

v. Show that rejecting or expiring the confirmation cancels the document action.

**Success criteria:** A presenter can follow Flow A from dropped file to approval decision without needing backend logs or hidden steps.

## 7. Generate and display Flow A artifacts

### 7a) Create the cited DOCX and local PDF preview

**Owner:** Supreet

**Do:**

i. Write the approved note into a DOCX below the current run’s output folder.

ii. Add a “Grounding references” section with the SOP sections used.

iii. Refuse to create the note if a citation does not match a retrieved source.

iv. Convert the DOCX to a PDF locally and keep the DOCX if PDF conversion fails.

v. Return safe artifact IDs to the renderer.

**Success criteria:** Flow A produces a DOCX containing the expected note and citation, plus a local PDF preview that can be opened in the app.

### 7b) Build the artifact pane

**Owner:** Ayush

**Do:**

i. Show the PDF preview when it is ready.

ii. Show the DOCX as a downloadable/openable artifact.

iii. Show a clear conversion error when the PDF is unavailable; never show a fake preview.

iv. Keep the transcript visible beside the artifact.

**Success criteria:** The user can see the approval note in the artifact pane and understand whether DOCX and PDF creation succeeded.

### 7c) Complete the first full Flow A run

**Owner:** Supreet

**Do:**

i. Run the fixed inspection report through the real Electron file-drop path.

ii. Confirm the extracted findings, expected SOP citation, route changes, confirmation, DOCX, and PDF.

iii. Fix only issues that stop or confuse this demo flow.

iv. Freeze the report, SOP, template, expected note content, and local artifact behavior.

**Success criteria:** The flagship demo works end to end from the real UI and is repeatable with the fixed files.

## 8. Build Flow B: CSV to verified coding result

### 8a) Prepare the coding task and model output

**Owner:** Sid

**Do:**

i. Prepare the fixed CSV with known out-of-range readings.

ii. Create the coding prompt that asks for a Python script and describes the expected result.

iii. Make the model return only the script and the expected result description needed by the backend.

iv. Adjust the prompt until the script handles the fixed CSV correctly.

v. After the switch to the local coding model in task 11a, re-run the fixed CSV against Qwen2.5-Coder and re-freeze the prompt.

**Success criteria:** The coding model produces usable Python for the fixed CSV task and the expected result is known in advance.

### 8b) Run generated Python safely

**Owner:** Supreet

**Do:**

i. Write the approved script into the current run folder as `task.py`.

ii. Run it with Bubblewrap, with the input mounted read-only, the output folder writable, and networking disabled.

iii. Use a fixed Python command and a 60-second timeout.

iv. Return the exit code, short stdout/stderr, and generated output files.

v. Require confirmation before execution.

**Success criteria:** The fixed script runs only after approval, cannot access the network or write outside its output folder, and returns a trustworthy success or failure result.

### 8c) Build the Flow B experience

**Owner:** Ayush

**Do:**

i. Show the automatic code-route badge.

ii. Show the generated script or a concise script summary.

iii. Ask for confirmation before execution.

iv. Show stdout, stderr, exit code, and the result summary.

v. Show an XLSX artifact when the task requests one.

**Success criteria:** The user can see what code will run, approve it, and understand the verified result or failure from the UI.

## 9. Finish Flow B and common artifacts

### 9a) Connect Flow B end to end

**Owner:** Supreet

**Do:**

i. Connect CSV drop, code routing, file inspection, code drafting, confirmation, Bubblewrap execution, result summarisation, and artifact creation.

ii. Make the final explanation use the actual execution output, exit code, and generated files.

iii. Treat a timeout or non-zero exit as a failed verification, not a successful calculation.

**Success criteria:** The fixed CSV task completes through the real UI with the expected flags, result summary, exit code, and optional XLSX.

### 9b) Add XLSX output

**Owner:** Supreet

**Do:**

i. Turn validated result rows into an `.xlsx` file below the run’s output folder.

ii. Return the file as an artifact alongside the transcript result.

iii. Show an error instead of producing a file when the result data is incomplete.

**Success criteria:** Flow B can produce and display a usable XLSX from the verified result when requested.

### 9c) Make both flows feel like one product

**Owner:** Ayush

**Do:**

i. Use one transcript style for both flows.

ii. Keep route badges, confirmation dialogs, errors, and artifacts visually consistent.

iii. Make “new run” clear old transient events and artifacts while keeping run history.

**Success criteria:** A user can switch between the two demos without learning a different interface, and no state from one run leaks into the next.

## 10. Add the proof and failure behavior

### 10a) Add confirmations, cancellation, and clear failures

**Owner:** Supreet

**Do:**

i. Require confirmation for DOCX/XLSX creation and Python execution.

ii. Record who approved or rejected the action and when.

iii. Cancel pending work when the user cancels a run.

iv. Expire unanswered confirmations after five minutes.

v. Show clear failures for unavailable models, bad model output, missing SOP sources, timeouts, conversion failures, and failed Python execution.

**Success criteria:** Protected actions never happen silently, cancellation and rejection prevent the action, and every known failure appears as a visible failed or cancelled run.

### 10b) Finish local run history and audit trail

**Owner:** Supreet

**Do:**

i. Store run status, route choices, agent steps, confirmations, citations, artifacts, and failures in SQLite.

ii. Keep large files and intermediate content in the run folder rather than putting them into the database.

iii. Show recent runs in the UI with their status and artifacts.

**Success criteria:** The team can explain what happened in any demo run from local history, including which models ran, what was approved, and what artifacts were created.

### 10c) Build the visible sovereignty panel

**Owner:** Ayush

**Do:**

i. Keep the five approved LAN hosts visible in the panel.

ii. Show local service connection status and the application’s external-request count.

iii. Keep the zero-external-request state visible during both flows, confirmations, and artifact preview in rehearsal sessions against the local models; during OpenRouter development the panel shows the true external count instead.

iv. Show whether the independent monitor is active.

v. Clearly separate application telemetry from the independent monitor’s blocked-egress evidence.

**Success criteria:** The panel is always visible, shows the approved allowlist and zero external requests for the clean demo session, and never invents a blocked event or monitor result.

### 10d) Capture the independent blocked-egress proof

**Owner:** Sid

**Do:**

i. Run the independent monitor/firewall while launching the app and running both flows.

ii. Confirm that observed traffic stays between approved LAN hosts and that external requests remain at zero.

iii. Run the preconfigured controlled outbound attempt through the infrastructure procedure.

iv. Save the monitor record showing the attempt was blocked.

**Success criteria:** The demo has independent evidence for zero external traffic and one blocked outbound attempt; the application itself never gains an internet feature.

## 11. Package, rehearse, and hand off

### 11a) Switch to the local models and package the offline demo

**Owner:** Supreet

**Do:**

i. Install the local models on their task 1b hosts (Qwen2.5-VL on the M4, Qwen3 on i7 #1, Qwen2.5-Coder on i7 #2), start each from local files, and confirm the application host reaches each over the LAN.

ii. Repoint `config/models.json` from the OpenRouter development entries to those local endpoints, strip the OpenRouter entries and any key material from the demo bundle, and re-run all health checks.

iii. Re-validate the frozen prompts from tasks 5b, 6b, and 8a against the local models; record any adjustment in the change log of `docs/demo-requirements.md`.

iv. Package the Electron app, local dependencies, model startup instructions, embedding service, Chroma corpus, LibreOffice, Bubblewrap, configuration, fixtures, and run data setup.

v. Write the operator runbook in startup order: boot hosts, start services, launch the app, check health, and run the two flows.

vi. Include the fixed IPs, ports, model aliases, fixture locations, and recovery steps for a failed health check.

vii. Install or start the bundle once with external networking disconnected.

**Success criteria:** Another team member can start the demo from local assets without downloading anything, both fixed input files are available on the application host, and both flows pass against the local models before rehearsal.

### 11b) Do the final Flow A and Flow B rehearsal

**Owner:** Sid

**Do:**

i. Start from a clean app session with the independent monitor already running.

ii. Run Flow A and confirm the vision route, drafting route, SOP citation, DOCX, and PDF.

iii. Reset the app, run Flow B, and confirm the code route, approval, sandboxed result, exit code, and XLSX if used.

iv. Repeat each flow with the exact fixed files and record any step that still needs a fix.

**Success criteria:** Both flows work repeatedly with external networking disconnected and match the product demo story without improvised model behavior.

### 11c) Polish the final presentation and handoff

**Owner:** Ayush

**Do:**

i. Make the transcript, route badges, sovereignty panel, confirmation dialogs, errors, and artifact pane readable at demo resolution.

ii. Confirm the app opens in the right initial state and that “new run” reliably resets the demo.

iii. Prepare the short presenter script for Flow A, Flow B, and the blocked-egress proof.

iv. Collect the final build identifier, fixture names, service versions, screenshots, and monitor evidence in the handoff folder.

**Success criteria:** A presenter can run the complete session without hidden UI steps, and the final build, runbook, fixtures, and proof materials are ready to use.

## Final completion checklist

- Automatic routing is visible across both flows: `vision` then `draft` for Flow A, and `code` for Flow B.
- Flow A reads the fixed scanned report, extracts findings, retrieves the local SOP, and creates a cited DOCX plus PDF preview.
- Flow B generates Python for the fixed CSV, runs it only after confirmation in a network-disabled sandbox, and shows the verified result.
- DOCX/XLSX creation, Python execution, run cancellation, and known failures behave as described in the UI.
- The live transcript shows the agent’s plan, tool calls, observations, route changes, confirmations, and final artifacts.
- The sovereignty panel stays visible, shows the approved LAN allowlist and zero external requests, and the independent monitor records a blocked outbound attempt.
- Everything required for the demo runs from local assets and fixed fixtures with external networking disconnected.

