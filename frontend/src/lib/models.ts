export type Model = {
  id: string;
  name: string;
  desc: string;
  role?: "primary";
};

/**
 * Build the right-side model choices from the role configuration. Draft is
 * first, so it is the default when the user has not selected a model before.
 * The first route keeps the internal primary-model ID for compatibility.
 */
export function getModelRoutes(configuredModels?: ModelConfigRow[] | null): Model[] {
  if (!configuredModels) return [{ id: "primary-model", role: "primary", name: "qwen3.5:9b", desc: "Configured local model" }];
  const usable = configuredModels.filter((model) => model.role !== "embedding" && model.modelName?.trim());
  const primary = usable.filter((model) => model.role === "primary");
  const roleOrder: ModelRoleType[] = ["draft", "vision", "coding"];
  const roleModels = roleOrder.flatMap((role) => usable.filter((model) => model.role === role));
  // Restore settings from versions that stored only one general-purpose model.
  const candidates = roleModels.length > 0 ? roleModels : primary;
  const seen = new Set<string>();
  return candidates.filter((model) => {
    const key = `${model.host}:${model.port}/${model.modelName.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((model, index) => ({
    id: index === 0 ? "primary-model" : `model-${index + 1}`,
    role: "primary",
    name: model.modelName,
    desc: `Configured for ${model.role === "primary" ? "Draft, Vision, and Coding" : model.role}`,
  }));
}

export const MODELS: Model[] = getModelRoutes();
