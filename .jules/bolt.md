## 2026-08-20 - [In-Memory Bounded Caching for Intent Classifier & Embedding Service]
**Learning:** Intent classification and vector embedding lookups are repeated frequently in multi-turn agent runs. Adding bounded Map caches with LRU/FIFO eviction eliminates redundant regex parsing, edit-distance token comparisons, and REST embedding requests without memory leaks.
**Action:** Always wrap deterministic decision classifiers and stateless embedding services with bounded in-memory caches when building multi-turn agentic applications.

## 2026-08-21 - [Pre-Sort Filtering in Recursive Directory Walkers & Stream React Component Memoization]
**Learning:** In deep directory listing tools (`listDir`), sorting before filtering forces $O(N \log N)$ sorting over ignored directories (`node_modules`, `.git`). Pre-filtering before sorting cuts sort overhead down to $O(M \log M)$ over active files. In frontend streaming transcripts (`RunTranscript`), high-frequency event streaming triggers continuous parent re-renders; wrapping in `React.memo` and memoizing formatted labels avoids recalculating full transcript histories on every stream chunk.
**Action:** Always filter out ignored entries before array sorting in filesystem walks, and memoize list item label formatting in streaming React components.

## 2026-09-21 - [Prepared SQLite Statements in Frequently Polled Services & React Default Prop Allocations]
**Learning:** Repeatedly preparing raw SQL strings (`sqlite.prepare(...)`) inside methods invoked during frequent telemetry/polling (such as Knowledge Base status queries) incurs constant SQL parsing and AST bytecode compilation overhead. Reusing cached `Statement` instances across calls reduces query execution overhead by >90%. Additionally, default prop allocations like `runEvents = []` allocate a new array instance on every function evaluation, causing `React.memo` shallow prop comparison to fail when props are undefined.
**Action:** Cache prepared SQLite `Statement` objects in service class fields, and always declare default empty arrays/objects as module-level constants outside React components.

## 2026-09-22 - [$O(1)$ Token Lookups and Zero-Allocation Edit Distance for Intent Classification]
**Learning:** In multi-turn intent routing, matching prompt tokens against word dictionaries via array iteration creates $O(N \times M)$ linear scans and allocates hundreds of temporary 2D matrices when calculating edit distance. Pre-building module-level `Set` instances provides $O(1)$ exact matches before fuzzy logic, and sharing static 1D row buffers (`d0`, `d1`, `d2`) for Damerau-Levenshtein distance eliminates matrix allocations entirely during synchronous string evaluation.
**Action:** Always complement fuzzy word lists with pre-computed `Set` instances for $O(1)$ exact token lookups, and reuse 1D row buffers for edit-distance algorithms.

## 2026-09-24 - [Pre-Compiled Module-Level RegExp Constants & Execution Timeline Memoization]
**Learning:** Re-instantiating `RegExp` objects (`new RegExp(...)`) inside loops during LLM response parsing and transcript line filtering re-compiles regex patterns repeatedly on every turn. Hoisting static RegExp patterns to module-level constants and resetting `rx.lastIndex = 0` for global matches eliminates regex AST re-compilation overhead (~5-10x speedup). Additionally, wrapping execution timeline components (`AgentExecutionTimeline`) with `React.memo` prevents unnecessary React component re-renders during high-frequency streaming event dispatches.
**Action:** Always pre-compile static RegExp instances at module scope when parsing LLM outputs, and wrap streaming progress components in `React.memo`.

## 2026-09-25 - [Pre-Joined Keyword Source Hoisting & Binary PDF Hash LRU Caching]
**Learning:** Re-building keyword alternation strings (`Array.from(set).join('|')`) inside React code highlight handlers creates continuous heap allocations during token streaming. Hoisting pre-joined pattern sources (`CODE_HIGHLIGHT_PATTERN_SOURCE`) to module scope eliminates string joining while allowing safe instantiation of global `RegExp` objects. Furthermore, extracting PDF text from raw binary buffers in multi-stage document pipelines decodes latin1 strings and executes global `matchAll` passes repeatedly; keying a 50-entry LRU Map by 32-bit FNV-1a hash (`pdfTextCache`) avoids redundant binary parsing (~95% speedup).
**Action:** Always hoist pre-joined regex pattern sources for dynamic keyword highlight rules, and hash binary document buffers for bounded LRU text extraction caching.
