# V0 demo runbook

This runbook describes the current CLI demo. It uses the checked-in demonstration files and the live local model endpoint. Model output can vary between runs. See [FRAMEWORK.md](FRAMEWORK.md) for the authoritative evaluation rules and [V0 shipping status](docs/V0_SHIPPING_STATUS.md) for the certified results.

## Set up the local models

1. Start LM Studio and its OpenAI-compatible server at `http://127.0.0.1:1234/v1`.
2. Load `qwen2.5-coder-7b-instruct-mlx` as the primary model. Load `qwen/qwen3-vl-4b` for visual input.
3. Configure the exact model IDs in the app. For knowledge search, use the embedding model ID exposed by LM Studio. The certified environment used `text-embedding-nomic-embed-text-v1.5`.

The package does not include model weights. The model setup is described in [README.md](README.md).

## Run Flow A, B, and C

From the repository root, run:

```sh
npm run demo
```

The live CLI harness runs one trial of each flow by default:

- **Flow A:** review the document bundle and available requirements, then create the requested document artifact.
- **Flow B:** repair the supplied program, run it on the supplied input, and return the verified source.
- **Flow C:** inspect the supplied drawing against its reference requirements and report findings.

The command uses local model services and the files under `demo/`. It is not a repeat of the nine-task V0 certification. A single run does not prove universal reliability.
