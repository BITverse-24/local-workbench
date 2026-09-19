## 2026-08-20 - [In-Memory Bounded Caching for Intent Classifier & Embedding Service]
**Learning:** Intent classification and vector embedding lookups are repeated frequently in multi-turn agent runs. Adding bounded Map caches with LRU/FIFO eviction eliminates redundant regex parsing, edit-distance token comparisons, and REST embedding requests without memory leaks.
**Action:** Always wrap deterministic decision classifiers and stateless embedding services with bounded in-memory caches when building multi-turn agentic applications.

## 2026-08-21 - [Pre-Sort Filtering in Recursive Directory Walkers & Stream React Component Memoization]
**Learning:** In deep directory listing tools (`listDir`), sorting before filtering forces $O(N \log N)$ sorting over ignored directories (`node_modules`, `.git`). Pre-filtering before sorting cuts sort overhead down to $O(M \log M)$ over active files. In frontend streaming transcripts (`RunTranscript`), high-frequency event streaming triggers continuous parent re-renders; wrapping in `React.memo` and memoizing formatted labels avoids recalculating full transcript histories on every stream chunk.
**Action:** Always filter out ignored entries before array sorting in filesystem walks, and memoize list item label formatting in streaming React components.
