import type { AIResult, ModelHealth, ModelId, ModelRequest, ModelResponse } from "../../shared/contracts.js";

/**
 * Provider-agnostic model surface. Implementations (local servers)
 * are selected through the registry; callers never name a
 * provider transport directly.
 */

export interface ModelClient {
  complete(request: ModelRequest): Promise<AIResult<ModelResponse>>;
  health(modelId: ModelId): Promise<ModelHealth>;
}
