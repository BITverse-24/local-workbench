import type { MockHandler } from "./model-relay.js";

export const repairedParser = 'import csv\nimport io\n\ndef parse_csv(text):\n    return list(csv.DictReader(io.StringIO(text)))\n';
export function parserMock(options: { brokenRepair?: boolean; fault?: "invalid-json" | "http-429" | "http-500" | "empty" | "truncated-stream"; } = {}): MockHandler {
  let turn = 0;
  return (route, body) => {
    if (route.endsWith("/models")) return { body: { data: [{ id: body.model ?? "mock" }] } };
    if (route.endsWith("/embeddings")) { const input = Array.isArray(body.input) ? body.input : [body.input]; return { body: { data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) } }; }
    const messages = body.messages as Array<{ role: string; content: string }>;
    const system = messages?.find((m) => m.role === "system")?.content ?? "";
    if ((body.response_format as any)?.json_schema?.name === "semantic_intent") return completion(body, JSON.stringify({ requestedAction: "modify_software", responseMode: "chat", primaryGoal: "Repair CSV parser", workspaceMutationRequested: true, workspaceOperations: [{ operation: "write", targetPath: "parser.py" }], targetFiles: ["parser.py"], protectedPaths: ["README.md", "test_parser.py"], restrictMutationsToTargets: true, validationRequested: true, expectedDeliverables: [] }));
    if (options.fault === "http-429") return { status: 429, body: { error: { message: "Fixture rate limit" } } };
    if (options.fault === "http-500") return { status: 500, body: { error: { message: "Fixture provider failure" } } };
    if (options.fault === "invalid-json") return { raw: "this is not JSON" };
    if (options.fault === "empty") return completion(body, "");
    if (options.fault === "truncated-stream") return { raw: 'data: {"choices":[{"delta":{"content":"unfinished', contentType: "text/event-stream" };
    turn++;
    if (turn === 1) return completion(body, "Inspect the parser before repairing it.", [{ name: "read_file", arguments: { path: "parser.py" } }]);
    if (turn === 2) return completion(body, "Repair only the parser.", [{ name: "write_file", arguments: { path: "parser.py", content: options.brokenRepair ? 'def parse_csv(text):\n    return []\n' : repairedParser } }]);
    if (turn === 3) return completion(body, "Validate the written parser.", [{ name: "run_command", arguments: { command: 'python3 -B -c "import parser; assert parser.parse_csv(\'name,value\'+chr(10)+\'alpha,2\'+chr(10)) == [{\'name\': \'alpha\', \'value\': \'2\'}]; print(\'VALIDATION_OK\')"' } }]);
    return completion(body, "Repaired parser.py and ran validation. Quoted fields, headers and blank lines are handled using csv.DictReader.");
  };
}
export function completion(body: Record<string, unknown>, content: string, calls?: Array<{ name: string; arguments: unknown }>): ReturnType<MockHandler> {
  if (calls && !body.tools && JSON.stringify(body.messages).includes("AVAILABLE TOOLS:")) {
    content = JSON.stringify({ tool_calls: calls, content });
    calls = undefined;
  }
  const tool_calls = calls?.map((c, index) => ({ index, id: `mock_call_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
  if (body.stream) return { contentType: "text/event-stream", chunks: [`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, tool_calls }, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\n`, "data: [DONE]\n\n"] };
  return { body: { choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0 } } };
}
