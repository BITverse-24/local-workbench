import { ModelGateway } from '../../src/main/gateway/model-gateway.js';
import type { ModelRegistryEntry } from '../../src/shared/contracts.js';

/** Integration fixtures must not read the developer's mutable model settings. */
export function testModelRegistry(): ModelRegistryEntry[] {
  return [
    {id:'primary-model',runtime:'ollama',baseUrl:'http://127.0.0.1:11434/v1',model:'fixture-text-model',capabilities:['text','structured-output','code-generation'],requestTimeoutMs:30000,healthPath:'/models',enabled:true,contextLength:16384,maxOutputTokens:3072},
    {id:'vision-fallback',runtime:'ollama',baseUrl:'http://127.0.0.1:11434/v1',model:'fixture-vision-model',capabilities:['text','image-input','structured-output'],requestTimeoutMs:30000,healthPath:'/models',enabled:true,fallbackOnly:true,contextLength:16384,maxOutputTokens:3072},
  ];
}

export function testModelGateway(): ModelGateway { return new ModelGateway(undefined,testModelRegistry()); }
