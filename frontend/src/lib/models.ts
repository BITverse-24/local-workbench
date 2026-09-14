export type Model = {
  id: string;
  name: string;
  desc: string;
  role?: "vision" | "plan" | "coding" | "draft";
};

/**
 * Builds the 4 model route preferences: Vision, Plan, Coding, Draft.
 * Dynamically uses the user's configured model name from onboarding (e.g. Qwen 2.5 Coder 7B)
 * instead of hardcoded placeholder names like "Qwen3 4B".
 */
export function getModelRoutes(configuredModels?: ModelConfigRow[] | null): Model[] {
  const findModelName = (role: string) => {
    if (!configuredModels || configuredModels.length === 0) return null;
    const match = configuredModels.find((m) => m.role === role);
    return match?.modelName || null;
  };

  const codingModel = findModelName("coding");
  const draftModel = findModelName("draft");
  const visionModel = findModelName("vision");
  const planModel = findModelName("plan");

  const singleConfigured =
    codingModel || draftModel || planModel || visionModel || null;

  return [
    {
      id: "code-qwen25coder",
      role: "coding",
      name: codingModel ? `Coding (${codingModel})` : (singleConfigured ? `Coding (${singleConfigured})` : "Coding & Analysis"),
      desc: "Python scripts, workspace harness, CSV parsing",
    },
    {
      id: "draft-qwen3",
      role: "draft",
      name: draftModel ? `Draft (${draftModel})` : (singleConfigured ? `Draft (${singleConfigured})` : "Draft & Reasoning"),
      desc: "Approval notes, synthesis, technical memos, chat",
    },
    {
      id: "vision-qwen25vl",
      role: "vision",
      name: visionModel ? `Vision (${visionModel})` : (singleConfigured ? `Vision (${singleConfigured})` : "Vision & OCR"),
      desc: "Inspection reports, engineering drawings, P&ID diagrams",
    },
    {
      id: "plan-qwen3-8b",
      role: "plan",
      name: planModel ? `Plan (${planModel})` : (singleConfigured ? `Plan (${singleConfigured})` : "Routing & Planning"),
      desc: "Multi-stage subtask decomposition & orchestration",
    },
  ];
}

export const MODELS: Model[] = getModelRoutes();
