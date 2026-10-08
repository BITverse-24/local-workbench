const fs = require("node:fs");
const path = require("node:path");

const audit = __dirname;
const reference = JSON.parse(fs.readFileSync(path.join(audit, "../phase1.6/trials/bounded-1/requests.jsonl"), "utf8").split("\n").find((line) => line.includes('"purpose":"working_1"')));
const schedule = ["baseline", "source-context-guidance", "source-context-guidance", "baseline", "baseline", "source-context-guidance"];

async function trial(condition, index) {
  const started = performance.now();
  const payload = {
    model: reference.model,
    messages: reference.inputMessages.map((message, messageIndex) => messageIndex === 0 && condition === "source-context-guidance"
      ? { ...message, content: message.content + "\n\nWhen the complete target source is already included in this request, use that source directly. Read it with a tool only if it is missing, incomplete, changed during this run, or conflicts with another concrete observation." }
      : message),
    tools: reference.inputTools,
    tool_choice: "auto",
    temperature: 0.2,
    max_tokens: 1024,
    presence_penalty: 0.1,
    stream: true,
    stream_options: { include_usage: true },
  };
  const response = await fetch("http://127.0.0.1:1234/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!response.ok || !response.body) throw new Error("LM Studio HTTP " + response.status + ": " + (await response.text()));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", usage = null, finishReason = null;
  const calls = new Map();
  let reasoningChars = 0, contentChars = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const text = line.slice(5).trim();
      if (!text || text === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(text); } catch { continue; }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      finishReason = choice.finish_reason ?? finishReason;
      const delta = choice.delta || {};
      reasoningChars += String(delta.reasoning_content || delta.reasoning || "").length;
      contentChars += String(delta.content || "").length;
      for (const part of delta.tool_calls || []) {
        const item = calls.get(part.index) || { name: "", argumentsChars: 0 };
        if (part.function?.name) item.name = part.function.name;
        if (part.function?.arguments) item.argumentsChars += part.function.arguments.length;
        calls.set(part.index, item);
      }
    }
  }
  const row = {
    index, condition, temperature: 0.2, model: reference.model, status: response.status,
    durationMs: Math.round(performance.now() - started), finishReason,
    usage, reasoningChars, contentChars, toolCalls: [...calls.values()],
  };
  console.log(JSON.stringify(row));
  return row;
}

(async () => {
  const results = [];
  for (let i = 0; i < schedule.length; i++) results.push(await trial(schedule[i], i + 1));
  fs.writeFileSync(path.join(audit, "prompt-ablation-results.json"), JSON.stringify(results, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
