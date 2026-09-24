# Deployment and Sovereignty

## Finals LAN topology

| Machine | Role | Initial Software / Model | Allowed Inbound Peer |
| --- | --- | --- | --- |
| M4 Mac Mini, 16 GB | Vision / multimodal drawing server | Qwen2.5-VL-3B-Instruct (4-bit MLX via `mlx_lm.server`) / Qwen3-VL | Orchestrator only |
| i7, 16 GB #1 | Drafting & reasoning server | Qwen3-4B-Instruct / Qwen3-8B (GGUF Q4 via `llama-server` or Ollama) | Orchestrator only |
| i7, 16 GB #2 | Coding & repair server | Qwen2.5-Coder-7B-Instruct (GGUF Q4 via `llama-server` or Ollama) | Orchestrator only |
| i7, 16 GB #3 | Application host | Electron desktop app, Node runtime, SQLite, local RAG (ChromaDB / Vectra), Python 3 sandbox | Renderer-local; model LAN peers |

Each model has a fixed LAN address and port entered in `config/models.json` or configured dynamically via the desktop **Onboarding & Model Settings** wizard (which tests live endpoints via `/v1/models` and persists configuration in SQLite). No external DNS discovery, cloud telemetry SDK, or arbitrary internet URL is permitted.

---

## Offline provisioning checklist

Before disconnecting from the setup network:

1. Download and checksum all model weights (GGUF / MLX), Python packages, Node modules, Electron bundle, and local SOP standards (`demo/flow_a`, `demo/flow_c`).
2. Transfer packages to the approved LAN hosts, install from local caches, and lock configuration versions.
3. Start model services using approved server binaries (`mlx_lm.server`, `llama-server`, or `ollama`); verify `/v1/models` endpoints respond with healthy latency.
4. Index governing standards (e.g. `SOP-114`, `SOP-220`) into the local vector database using the Knowledge Base UI or CLI preflight.
5. Disconnect all external networking cables and Wi-Fi adapters; verify the private LAN router maintains host-to-host connectivity without default internet gateway routing.
6. Run the offline fixture validator:
   ```bash
   python3 demo/validate_fixtures.py
   ```
7. Execute all three end-to-end rehearsal flows (Flow A, Flow B, Flow C) air-gapped before final evaluation.

---

## Independent egress evidence

The zero-egress proof is maintained outside the application process:

- A physical network monitor / firewall or switch mirror port observes traffic from the four hosts and records packet counters.
- The desktop shell displays live air-gapped status in the titlebar and telemetry drawer based on internal socket binding rules.
- During evaluation, the demo operator provides independent packet capture / switch log evidence demonstrating:
  1. Exactly **0 external outbound requests** across all three flows.
  2. Permitted TCP packets exchanged exclusively between registered LAN IP addresses and ports.
  3. A controlled outbound request (e.g. attempting to curl an external IP) that is demonstrably dropped and logged by the firewall.

---

## Python execution isolation

Python tasks (such as vendor log repair in Flow B or data calculation) execute within strict isolation:

- **Linux Production Host**: Utilizes **Bubblewrap** (`bwrap`) to invoke Python with:
  - An unshared network namespace (`--unshare-net`) blocking all socket creation.
  - Read-only mounts (`--ro-bind`) for system runtimes (`/usr`, `/bin`) and the run input directory (`/input`).
  - Read-write bind mount confined strictly to the run-scoped output folder (`/output`).
  - Strict 60-second wall-clock timeout and capped stdout/stderr buffers (16KB max).
- **macOS Development Host**: Utilizes `sandbox-exec` profiles (when enabled) or validated subprocess execution confined to the run output directory, strictly denying network syscalls.
- **Output Artifact Containment**: Any output CSVs, transformed logs, or repaired script copies are isolated in `data/runs/<runId>/output/` and registered with SHA-verified metadata.

---

## Service health and failure policy

1. Electron main and the frontend bridge query `/v1/models` health checks at startup and during model reconfiguration.
2. The UI Service Health indicators reflect real-time latency and connection status for vision, draft, code, and embedding endpoints.
3. If an endpoint becomes unreachable, the agent loop halts gracefully with a clear error; it **never** falls back to unauthorized cloud providers.
4. Operators can test and re-bind model ports live via the Onboarding modal without application restarts.
