// Audit-only fetch instrumentation. No repository runtime source is changed.
const fs = require("node:fs");
const path = require("node:path");
const originalFetch = global.fetch;
let sequence = 0;
const started = new Map();
const outDir = process.env.FLOW_AUDIT_OUTDIR;

function append(record) {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(path.join(outDir, "requests.jsonl"), JSON.stringify(record) + "\n");
}

global.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url || "";
  if (!/127\.0\.0\.1:1234\/v1\/chat\/completions/.test(url)) return originalFetch(input, init);

  let payload;
  try { payload = JSON.parse(init.body || "{}"); } catch { payload = {}; }
  // Ask for final usage in streaming responses. Applied equally to old/current runs.
  if (payload.stream === true) payload.stream_options = { ...(payload.stream_options || {}), include_usage: true };
  const body = JSON.stringify(payload);
  const id = `${process.pid}-${++sequence}`;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const sys = messages.filter((m) => m.role === "system").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
  const userText = messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
  const isClassifier = /Semantic Intent Orchestrator|intent classifier|intent_classification/i.test(sys) ||
    (messages.length === 2 && !Array.isArray(payload.tools) && /LATEST USER REQUEST/i.test(userText));
  const purpose = isClassifier ? "classification" : `working_${(started.get("working") || 0) + 1}`;
  if (!isClassifier) started.set("working", (started.get("working") || 0) + 1);
  const record = {
    id,
    purpose,
    timestamp: new Date().toISOString(),
    model: payload.model,
    inputMessages: messages,
    inputTools: payload.tools || [],
    stream: Boolean(payload.stream),
    messageCount: messages.length,
    requestBodyChars: body.length,
    systemPromptChars: sys.length,
    userPromptChars: messages.filter((m) => m.role === "user").reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0),
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    toolSchemaChars: Array.isArray(payload.tools) ? JSON.stringify(payload.tools).length : 0,
    toolNames: (payload.tools || []).map((t) => t?.function?.name).filter(Boolean),
    generation: Object.fromEntries(["temperature", "max_tokens", "top_p", "presence_penalty", "reasoning_effort", "chat_template_kwargs", "stream_options"].filter((k) => payload[k] !== undefined).map((k) => [k, payload[k]])),
    ttftMs: null,
    reasoningTtftMs: null,
    visibleTtftMs: null,
    durationMs: null,
    status: null,
    usage: null,
    finishReason: null,
    outputChars: { content: 0, reasoning: 0, toolArguments: 0 },
    outputText: { content: "", reasoning: "" },
    toolCalls: [],
  };
  const t0 = performance.now();
  try {
    const response = await originalFetch(input, { ...init, body });
    record.status = response.status;
    if (!payload.stream || !response.body?.tee) {
      const clone = response.clone();
      clone.json().then((envelope) => {
        record.usage = envelope.usage || null;
        const msg = envelope.choices?.[0]?.message || {};
        record.finishReason = envelope.choices?.[0]?.finish_reason || null;
        record.outputChars.content = typeof msg.content === "string" ? msg.content.length : 0;
        record.outputChars.reasoning = String(msg.reasoning_content || msg.reasoning || "").length;
        record.outputText.content = typeof msg.content === "string" ? msg.content : "";
        record.outputText.reasoning = String(msg.reasoning_content || msg.reasoning || "");
        record.toolCalls = (msg.tool_calls || []).map((c) => ({ name: c.function?.name, argumentsChars: String(c.function?.arguments || "").length }));
        record.outputChars.toolArguments = record.toolCalls.reduce((n, c) => n + c.argumentsChars, 0);
      }).catch(() => {}).finally(() => {
        record.durationMs = Math.round(performance.now() - t0);
        append(record);
      });
      return response;
    }

    const [clientBody, auditBody] = response.body.tee();
    (async () => {
      const reader = auditBody.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            let chunk;
            try { chunk = JSON.parse(raw); } catch { continue; }
            if (chunk.usage) record.usage = chunk.usage;
            const choice = chunk.choices?.[0];
            const delta = choice?.delta || {};
            const now = Math.round(performance.now() - t0);
            if (typeof delta.content === "string" && delta.content.length) {
              if (record.ttftMs === null) record.ttftMs = now;
              if (record.visibleTtftMs === null) record.visibleTtftMs = now;
              record.outputChars.content += delta.content.length;
              record.outputText.content += delta.content;
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) {
              if (record.ttftMs === null) record.ttftMs = now;
              if (record.reasoningTtftMs === null) record.reasoningTtftMs = now;
              record.outputChars.reasoning += delta.reasoning_content.length;
              record.outputText.reasoning += delta.reasoning_content;
            }
            for (const tc of delta.tool_calls || []) {
              if (record.ttftMs === null) record.ttftMs = now;
              if (record.visibleTtftMs === null) record.visibleTtftMs = now;
              const ix = tc.index ?? record.toolCalls.length;
              const call = record.toolCalls[ix] || (record.toolCalls[ix] = { name: "", argumentsChars: 0 });
              if (tc.function?.name) call.name += tc.function.name;
              if (tc.function?.arguments) call.argumentsChars += tc.function.arguments.length;
            }
            if (choice?.finish_reason) record.finishReason = choice.finish_reason;
          }
        }
      } catch (error) { record.captureError = String(error); }
      record.toolCalls = record.toolCalls.filter(Boolean);
      record.outputChars.toolArguments = record.toolCalls.reduce((n, c) => n + c.argumentsChars, 0);
      record.durationMs = Math.round(performance.now() - t0);
      append(record);
    })();
    return new Response(clientBody, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    record.durationMs = Math.round(performance.now() - t0);
    record.fetchError = String(error);
    append(record);
    throw error;
  }
};
