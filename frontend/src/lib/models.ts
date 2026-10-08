export type Model = {
  id: string;
  name: string;
  desc: string;
  role?: "primary";
};

/** A single configured model drives every semantic task type. */
export function getModelRoutes(configuredModels?: ModelConfigRow[] | null): Model[] {
  if (!configuredModels) return [{ id: "primary-model", role: "primary", name: "Primary Model", desc: "One local model for all tasks" }];
  const usable = configuredModels.filter((model) => model.role !== "embedding" && model.modelName?.trim());
  const primary = usable.filter((model) => model.role === "primary");
  const candidates = primary.length ? primary : [usable.find((model) => model.role === "draft") ?? usable[0]].filter(Boolean) as ModelConfigRow[];
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
    desc: `Configured local model (${model.modelName})`,
  }));
}

export const MODELS: Model[] = getModelRoutes();
