# Sovereign Workbench V0

Sovereign Workbench is a local-first desktop assistant. It can inspect documents, review drawings, repair small code files, run workspace tools, and create deliverables. It sends model requests to a local OpenAI-compatible endpoint.

## V0 reference setup

1. Install and start LM Studio. Load `qwen2.5-coder-7b-instruct-mlx` for the primary model and `qwen/qwen3-vl-4b` for image input.
2. Use the LM Studio server at `http://127.0.0.1:1234/v1`.
3. In Sovereign Workbench setup, enter the exact model IDs from LM Studio. Set the primary model to `qwen2.5-coder-7b-instruct-mlx`. Enable the visual fallback with `qwen/qwen3-vl-4b`.
4. For knowledge search, configure the embedding model that is loaded in LM Studio. The certified environment used `text-embedding-nomic-embed-text-v1.5`.

The app package does not contain model weights. It uses the local model server that you configure. The example file at `config/models.v0.example.json` has no credentials or machine-specific paths.

See [DEMO.md](DEMO.md) for the current Flow A/B/C CLI runbook.

## Build and checks

Use Node.js 22.12 or later and npm. Run `npm ci`, `npm run typecheck`, and `npm run build`. The full legacy test command still has known failures; see [the V0 shipping report](docs/V0_SHIPPING_STATUS.md) for the passing V0 core suite. Build the macOS installer with `npm run package`. The installer is unsigned until a Developer ID certificate is configured.

The V0 certification details and retained evidence are in [docs/V0_SHIPPING_STATUS.md](docs/V0_SHIPPING_STATUS.md) and [docs/evidence/v0/](docs/evidence/v0/). See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) before relying on model output.

The authoritative V0 evaluation rules are in [FRAMEWORK.md](FRAMEWORK.md).
