import type { ModelClient } from "./ports.js";
import type { AIResult, ChatModelRequest, ChatResult, ModelResponse } from "../../shared/contracts.js";
import { validateChat } from "../validators/responses.js";

/** Typed free-form chat boundary used by the non-attachment draft path. */
export class ChatModel {
  constructor(private readonly client: ModelClient) {}

  async complete(request: ChatModelRequest): Promise<AIResult<ChatResult>> {
    const response = await this.client.complete(request);
    if (!response.ok) return response;
    const result = validateChat((response.value as ModelResponse).result);
    return result.ok ? result : { ok: false, error: result.error };
  }
}
