export type Model = { id: string; name: string; desc: string };

// Task models from ai/model-registry.ts (developmentModelRegistry). The
// BAAI/bge-small-en-v1.5 embedding service is not a chat model — not listed.
// Ids match the backend ModelId so the selection can route directly in Phase 3/14.
export const MODELS: Model[] = [
  { id: 'draft-qwen3', name: 'Qwen3 4B', desc: 'drafting • approval notes' },
  { id: 'vision-qwen25vl', name: 'Qwen2.5-VL 3B', desc: 'vision • scanned reports' },
  { id: 'code-qwen25coder', name: 'Qwen2.5-Coder 7B', desc: 'code • CSV & scripts' },
];
