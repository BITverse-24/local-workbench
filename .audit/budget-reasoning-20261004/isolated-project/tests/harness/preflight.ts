import type { Profile } from "../config.js";

export async function preflightTarget(profile: Profile): Promise<Record<string, unknown>> {
  const identities: Record<string, unknown> = {};
  for (const model of profile.target.registry.filter((m) => m.enabled)) {
    const response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error(`Target preflight: ${model.id} returned HTTP ${response.status}`);
    const body = await response.json() as { data?: Array<{ id: string; owned_by?: string }> };
    const entry = body.data?.find((m) => m.id === model.model);
    if (!entry) throw new Error(`Target preflight: fixed model ${model.model} is not listed at ${model.baseUrl}`);
    let digest: string | undefined;
    if (model.runtime === "ollama") {
      try {
        const tags = await fetch(`${new URL(model.baseUrl).origin}/api/tags`, { signal: AbortSignal.timeout(5000), redirect: "error" });
        if (tags.ok) {
          const tagBody = await tags.json() as { models?: Array<{ name: string; model?: string; digest?: string }> };
          digest = tagBody.models?.find((m) => m.name === model.model || m.model === model.model)?.digest;
        }
      } catch { /* Digest availability is recorded separately from endpoint health. */ }
    }
    identities[model.id] = { model: model.model, digest: digest ?? "unavailable", ownedBy: entry.owned_by ?? "unavailable" };
  }
  return { versions: identities, versionIdentityComplete: Object.values(identities).every((m) => (m as { digest: string }).digest !== "unavailable") };
}
