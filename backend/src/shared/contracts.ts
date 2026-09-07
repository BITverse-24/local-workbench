// Phase 0 — read-only mirror of `ai/contracts.ts` (see BACKEND_PLANS.md §1).
// Do not edit types here; edit `ai/contracts.ts` and keep this re-export in sync.
// NOTE: kept as a minimal placeholder (no cross-dir import) so `npm run build`
// stays green with `tsconfig.json` rootDir ".". Phase 4 (gateway) will switch
// this to `export * from "../../../ai/contracts.js"` together with the
// tsconfig include/rootDir adjustment that cross-dir import requires.
export {};
