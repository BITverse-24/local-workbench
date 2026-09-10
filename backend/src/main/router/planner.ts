import { requestBase, ModelGateway } from "../gateway/model-gateway.js";
import type { PlanModelRequest, SubtaskPlan } from "../../shared/contracts.js";
import { randomUUID } from "node:crypto";
import { routeTask } from "./deterministic-router.js";

const PLANNER_PROMPT = `You are an expert orchestrator. Break the user's request down into a sequence of specific subtasks.
Each subtask MUST be assigned a type:
- "vision": for extracting text, reading reports, or analyzing images/PDFs.
- "code": for data transformation, math, CSV processing, executing scripts, or any coding.
- "draft": for synthesizing answers, writing reports, or answering general questions.

Output strictly valid JSON matching this schema:
{
  "tasks": [
    { "id": "task_1", "type": "vision", "description": "Extract findings from the report" },
    { "id": "task_2", "type": "code", "description": "Calculate sums from the extracted data", "dependsOn": ["task_1"] }
  ]
}

DO NOT wrap your response in markdown code blocks. DO NOT output any extra text. Output ONLY raw JSON.`;

export async function generatePlan(
  runId: string,
  userText: string,
  gateway: ModelGateway,
  temperature?: number,
  attachment?: { mediaType: string; filename: string }
): Promise<SubtaskPlan> {
  // Fast Path: Cut latency to 0ms for simple, single-step prompts
  const isComplex = /\b(and then|next|after|also|first|second|step|multiple|both)\b/i.test(userText) || userText.length > 150;
  
  if (!isComplex) {
    const decision = routeTask(userText, attachment);
    return {
      tasks: [{ id: "task_1", type: decision.taskType, description: userText.slice(0, 50) || "Process request" }]
    };
  }

  // Complex Path: Use the planning model
  const contextText = attachment ? `\n\n[Attachment: ${attachment.filename}]` : "";
  const prompt = `${userText}${contextText}\n\nPlease generate the JSON subtask plan.`;

  const base = requestBase(
    runId,
    "plan",
    "plan-qwen3-8b",
    "chat-result",
    PLANNER_PROMPT,
    prompt,
    45000,
    1024,
    temperature
  );

  const request: PlanModelRequest = {
    ...base,
    taskType: "plan",
    modelId: "plan-qwen3-8b",
    responseFormat: "chat-result",
  };

  const response = await gateway.execute(request);
  if (!response.ok) {
    throw new Error("Failed to generate plan: " + response.error.message);
  }

  try {
    let text = (response.value.result as any).text;
    
    // Strip possible markdown wrapping if the model ignored instructions
    text = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    const plan = JSON.parse(text) as SubtaskPlan;
    if (!plan.tasks || !Array.isArray(plan.tasks)) {
      throw new Error("Invalid plan format: missing tasks array");
    }
    if (plan.tasks.length === 0) {
      plan.tasks.push({
        id: "task_fallback",
        type: "draft",
        description: "Process request",
      });
    }
    return plan;
  } catch (err) {
    console.warn("[planner] Failed to parse JSON plan, falling back to heuristic single task", err);
    const decision = routeTask(userText, attachment);
    return {
      tasks: [{ id: "task_fallback", type: decision.taskType, description: userText.slice(0, 50) || "Process request" }]
    };
  }
}
