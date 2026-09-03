export type Model = { id: string; name: string; desc: string };

export const MODELS: Model[] = [
  { id: 'gemini-pro', name: 'Gemini 1.5 Pro', desc: 'general drafting • 4B Q4' },
  { id: 'gemini-flash', name: 'Gemini 1.5 Flash', desc: 'fast • 2B Q4' },
  { id: 'qwen-coder', name: 'Qwen2.5-Coder 7B', desc: 'code • 7B Q4' },
  { id: 'qwen-vl', name: 'Qwen2.5-VL 3B', desc: 'vision • 3B' },
];
