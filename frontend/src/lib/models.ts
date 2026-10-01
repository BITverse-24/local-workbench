export type Model = {
  id: string;
  name: string;
  desc: string;
  role?: "vision" | "coding" | "draft";
};

/**
 * Builds the 3 lead model route preferences: Coding, Draft, Vision.
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

  const singleConfigured =
    codingModel || draftModel || visionModel || null;

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
  ];
}

export const MODELS: Model[] = getModelRoutes();
