# Deployment and Sovereignty

## Finals LAN topology

| Machine | Role | Initial software | Allowed inbound peer |
| --- | --- | --- | --- |
| M4 Mac Mini, 16 GB | vision/OCR server | Qwen2.5-VL-3B-Instruct 4-bit and `mlx_lm.server` | orchestrator only |
| i7, 16 GB #1 | drafting server | Qwen3-4B-Instruct GGUF Q4 and `llama-server` | orchestrator only |
| i7, 16 GB #2 | code server | Qwen2.5-Coder-7B-Instruct GGUF Q4 and `llama-server` | orchestrator only |
| i7, 16 GB #3 | application host | Electron app, TypeScript modules, SQLite, local criteria, LibreOffice, Bubblewrap | renderer-local; model LAN peers |

Each model has a fixed LAN address and port entered in `config/models.json`
before the rehearsal. The registry allowlist is exactly the model and embedding
hosts. No DNS discovery, cloud endpoint, remote model download, telemetry SDK,
or arbitrary URL is part of the application.

## Offline provisioning checklist

Before disconnecting the demo network:

1. Download and checksum all model weights, GGUF files, Python wheels, Node
   modules, Electron bundle, LibreOffice packages, Bubblewrap package, and
   embedding model on a staging network.
2. Transfer them to the five approved hosts, install from local media/caches,
   and record versions in the deployment notes.
3. Start each model service using a local model path and a stable model alias;
   verify `/v1/models` and a small fixture request from the orchestrator host.
4. Install the fixed Flow A criteria and decision oracles from
   `demo-fixtures/flow-a/`, then exercise criteria assessment against the
   inspection fixture.
5. Disconnect external networking, retain the private LAN, then repeat both
   end-to-end flows before finals.

## Independent egress evidence

The egress proof is deliberately outside the product. A separately configured
network monitor/firewall observes the five hosts and enforces/records the
approved LAN allowlist. The application UI may state the demo condition
(“external monitor active”), but it does not query, fabricate, or interpret
monitor counters.

The demo operator must retain evidence showing:

- no external outbound requests during the full rehearsal and the two flows;
- permitted traffic only between approved LAN addresses; and
- one controlled outbound attempt that the infrastructure blocks and records.

The blocked event is performed only through the preconfigured infrastructure
test procedure, never by adding an internet-capable feature to the application.

## Python execution isolation

Bubblewrap is the accepted MVP sandbox boundary on the Linux application host.
For every approved `execute_python` action, the fixed runner must:

- create an empty run-scoped output directory;
- bind-mount the specific input directory read-only and output directory
  writable;
- provide a minimal read-only Python runtime and a temporary filesystem;
- invoke Bubblewrap with a new network namespace (`--unshare-net`);
- run only the generated `task.py` using a fixed interpreter path;
- impose a 60-second wall-clock timeout and cap stdout/stderr captured into
  SQLite; and
- delete only temporary execution files after their audit summary is written.

Bubblewrap is not represented as production-grade hostile-code isolation. The
MVP claim is narrower: an approved Python task executes with no network,
scoped filesystem access, fixed interpreter invocation, and visible logs.

## Service health and failure policy

At application launch Electron main performs health checks against registry
entries and the local embedding service. The renderer displays unavailable
models before accepting a run. A model service failure does not trigger a
cloud fallback or substitution by a task-inappropriate local model. Operators
fix the host or update the tested registry between rehearsals.
