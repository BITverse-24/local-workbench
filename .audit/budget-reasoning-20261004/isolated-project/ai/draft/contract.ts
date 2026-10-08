import type { Finding, PageReference } from "../vision/contract";
import type { ModelRequestBase, ModelResponseBase } from "../shared/service-contract";

export type ApprovalNoteSectionId =
  | "equipment-header"
  | "findings-summary"
  | "recommendation";

export interface ApprovalNoteSection {
  id: ApprovalNoteSectionId;
  heading: string;
  body: string;
}

export interface MissingInformation {
  field: string;
  note: string;
}

export interface DraftResult {
  title: string;
  body: string;
  sections: ApprovalNoteSection[];
  missingInformation: MissingInformation[];
}

export type ApprovalNoteDraft = DraftResult;

export interface DraftModelRequest extends ModelRequestBase {
  taskType: "draft";
  modelId: "draft-qwen3";
  responseFormat: "draft-result";
  findings: Finding[];
  pageReferences: PageReference[];
  templateRequirements: string[];
}

export interface DraftModelResponse extends ModelResponseBase {
  taskType: "draft";
  result: DraftResult;
}
