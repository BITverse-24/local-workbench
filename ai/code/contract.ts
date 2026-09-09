import type { InputFileReference } from "../tools/contracts";
import type { ModelRequestBase, ModelResponseBase } from "../shared/service-contract";

export interface CodeDraftResult {
  filename: "task.py";
  source: string;
  expectedResult: string;
  inputFiles: string[];
  outputFiles: string[];
  allowedImports: string[];
}

export interface PythonExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputFiles: string[];
  durationMs: number;
}

export interface CodeSummaryResult {
  summary: string;
  verified: boolean;
}

export interface CodeModelRequest extends ModelRequestBase {
  taskType: "code";
  modelId: "code-qwen25coder";
  responseFormat: "code-result";
  task: string;
  inputFile: InputFileReference;
  allowedLanguage: "python";
  executionRules: string[];
}

export interface CodeSummarizeRequest extends ModelRequestBase {
  taskType: "code";
  modelId: "code-qwen25coder";
  responseFormat: "code-summary";
  phase: "summarize";
  execution: PythonExecutionResult;
  task: string;
}

export interface CodeModelResponse extends ModelResponseBase {
  taskType: "code";
  result: CodeDraftResult | CodeSummaryResult;
}
