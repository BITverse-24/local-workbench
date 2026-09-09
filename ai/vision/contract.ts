import type { AttachmentReference } from "../tools/contracts";
import type { ModelRequestBase, ModelResponseBase } from "../shared/service-contract";

export type Confidence = "high" | "medium" | "low";

export interface PageReference {
  id: string;
  page: number;
  text: string;
  location?: string;
}

export interface Finding {
  findingId: string;
  title: string;
  value: string;
  pageReferenceIds: string[];
  confidence: Confidence;
  evidence: string;
}

export interface VisionResult {
  sourceText: string;
  findings: Finding[];
  pageReferences: PageReference[];
  warnings?: string[];
}

export interface VisionModelRequest extends ModelRequestBase {
  taskType: "vision";
  modelId: "vision-qwen25vl";
  responseFormat: "vision-result";
  attachment: AttachmentReference;
  inputMode: "typed-scan";
}

export interface VisionModelResponse extends ModelResponseBase {
  taskType: "vision";
  result: VisionResult;
}
