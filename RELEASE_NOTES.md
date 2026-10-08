# Sovereign Workbench 0.1.0

V0 is a local-first desktop MVP for grounded document drafting, small code repair, and file or drawing inspection. It provides a scoped workspace harness, local model requests, optional knowledge retrieval, and DOCX deliverables.

The certified reference setup uses Qwen2.5 Coder 7B as the lead model and Qwen3-VL 4B for visual input. The app package contains no model weights. It connects to a local OpenAI-compatible server.

Certification reached 7/9 PASS, with at least 2/3 in each capability family, zero detected harness failures, 3/3 visual fallback checks, and 164/164 V0 core checks. Genuine successful A, B, and C recordings are retained. This result does not establish universal reliability.

Complex grounded document work can exceed the normal 120-second target. The successful Flow A run took 203 seconds and is accepted as a documented V0 exception. Some code paraphrases and document reviews remain incomplete, and Agent output can differ from a successful tool result. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) and [docs/V0_SHIPPING_STATUS.md](docs/V0_SHIPPING_STATUS.md).
