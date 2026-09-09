export type Model = { id: string; name: string; desc: string };

// Display labels for the registry in config/models.json (read-only mirror).
// Ids match the backend ModelId. Model selection is automatic (router-owned);
// this list is display-only.
export const MODELS: Model[] = [
  { id: 'draft-qwen3', name: 'Qwen3 4B', desc: 'drafting • approval notes' },
  { id: 'vision-qwen25vl', name: 'Qwen2.5-VL 3B', desc: 'vision • scanned reports' },
  { id: 'code-qwen25coder', name: 'Qwen2.5-Coder 7B', desc: 'code • CSV & scripts' },
];
