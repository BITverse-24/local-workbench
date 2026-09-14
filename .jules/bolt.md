## 2026-08-20 - [In-Memory Bounded Caching for Intent Classifier & Embedding Service]
**Learning:** Intent classification and vector embedding lookups are repeated frequently in multi-turn agent runs. Adding bounded Map caches with LRU/FIFO eviction eliminates redundant regex parsing, edit-distance token comparisons, and REST embedding requests without memory leaks.
**Action:** Always wrap deterministic decision classifiers and stateless embedding services with bounded in-memory caches when building multi-turn agentic applications.
