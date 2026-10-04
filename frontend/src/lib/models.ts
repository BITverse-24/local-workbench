export type Model = {
  id: string;
  name: string;
  desc: string;
  role?: "vision" | "coding" | "draft";
};

/**
 * Builds the available model list from onboarding / persistence configuration.
 *
 * Single-LLM configuration:
 * When onboarding establishes that exactly one usable LLM is configured,
 * returns an array containing that single model. The UI uses this to hide the dropdown.
 *
 * Multi-LLM configuration:
 * When multiple distinct usable LLMs are configured, returns each distinct model,
 * allowing the user to explicitly select which model drives execution.
 */
export function getModelRoutes(configuredModels?: ModelConfigRow[] | null): Model[] {
  if (!configuredModels || configuredModels.length === 0) {
    return [
      {
        id: "draft-qwen3",
        role: "draft",
        name: "Draft & Reasoning",
        desc: "Approval notes, synthesis, technical memos, chat",
      },
      {
        id: "code-qwen25coder",
        role: "coding",
        name: "Coding & Analysis",
        desc: "Python scripts, workspace harness, CSV parsing",
      },
      {
        id: "vision-qwen25vl",
        role: "vision",
        name: "Vision & OCR",
        desc: "Inspection reports, engineering drawings, P&ID diagrams",
      },
    ];
  }

  // Filter out non-inference models (embedding role is for vector search, not LLM inference)
  const llmRows = configuredModels.filter((m) => m.role !== "embedding" && m.modelName?.trim());
  if (llmRows.length === 0) {
    return [];
  }

  // Deduplicate entries that point to the exact same model endpoint (host:port + modelName)
  const distinctMap = new Map<string, ModelConfigRow>();
  for (const row of llmRows) {
    const key = `${row.host}:${row.port}/${row.modelName}`;
    if (!distinctMap.has(key)) {
      distinctMap.set(key, row);
    }
  }

  const distinctRows = Array.from(distinctMap.values());

  // Exactly one usable LLM configured -> Single-LLM mode
  if (distinctRows.length === 1) {
    const single = distinctRows[0];
    const id = single.role === "coding" ? "code-qwen25coder" : single.role === "vision" ? "vision-qwen25vl" : "draft-qwen3";
    return [
      {
        id,
        role: single.role as any,
        name: single.modelName,
        desc: `Configured local model (${single.modelName})`,
      },
    ];
  }

  // Multiple usable LLMs configured -> Multi-LLM mode
  return distinctRows.map((row) => {
    const id = row.role === "coding" ? "code-qwen25coder" : row.role === "vision" ? "vision-qwen25vl" : "draft-qwen3";
    const roleLabel = row.role === "coding" ? "Coding" : row.role === "vision" ? "Vision" : "Draft";
    const desc = row.role === "coding"
      ? "Python scripts, workspace harness, code operations"
      : row.role === "vision"
      ? "Inspection reports, drawings, visual inspection"
      : "Approval notes, reasoning, chat, technical memos";
    return {
      id,
      role: row.role as any,
      name: `${roleLabel} (${row.modelName})`,
      desc,
    };
  });
}

export const MODELS: Model[] = getModelRoutes();
