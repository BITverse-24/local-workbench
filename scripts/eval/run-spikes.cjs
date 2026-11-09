const http = require("node:http");

const MODEL = process.env.EVAL_MODEL || "qwen/qwen3.5-9b";
const ENDPOINT = "http://127.0.0.1:1234/v1/chat/completions";

function postJson(urlStr, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const body = JSON.stringify(data);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, raw });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function streamPost(urlStr, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const body = JSON.stringify({ ...data, stream: true });
    const start = Date.now();
    let ttft = null;
    let fullText = "";

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (res) => {
        res.on("data", (chunk) => {
          if (ttft === null) {
            ttft = Date.now() - start;
          }
          const text = chunk.toString();
          for (const line of text.split("\n")) {
            if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
              try {
                const parsed = JSON.parse(line.slice(6));
                const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.delta?.reasoning_content || "";
                fullText += delta;
              } catch {}
            }
          }
        });
        res.on("end", () => {
          const totalMs = Date.now() - start;
          resolve({ ttftMs: ttft ?? totalMs, totalMs, text: fullText });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function runSpike1PrefixCache() {
  console.log("\n=======================================================");
  console.log("SPIKE 1: Prefix-Cache Benchmark");
  console.log("=======================================================");

  // Build a 3K token stable prefix
  const paragraph = "This is stable architectural context for the Local Workbench agent engine. It describes the mode authority, three execution modes, filesystem isolation, sqlite persistence, tool dispatching, verification controller, and test runners in detail. ";
  const bigPrefix = paragraph.repeat(45); // ~3000 tokens

  console.log("Sending Request 1 (Initial cold prefix)...");
  const res1 = await streamPost(ENDPOINT, {
    model: MODEL,
    messages: [
      { role: "system", content: bigPrefix },
      { role: "user", content: "Question 1: What is 2 + 2? Answer in one word." }
    ],
    temperature: 0,
    max_tokens: 30
  });
  console.log(`Request 1 TTFT: ${res1.ttftMs}ms (Total: ${res1.totalMs}ms)`);

  console.log("Sending Request 2 (Identical prefix, new tail question)...");
  const res2 = await streamPost(ENDPOINT, {
    model: MODEL,
    messages: [
      { role: "system", content: bigPrefix },
      { role: "user", content: "Question 2: What is 5 + 5? Answer in one word." }
    ],
    temperature: 0,
    max_tokens: 30
  });
  console.log(`Request 2 TTFT: ${res2.ttftMs}ms (Total: ${res2.totalMs}ms)`);

  const speedup = ((res1.ttftMs - res2.ttftMs) / res1.ttftMs) * 100;
  console.log(`Prefix Cache TTFT Change: ${speedup >= 0 ? "-" : "+"}${Math.abs(speedup).toFixed(1)}%`);

  return { coldTtftMs: res1.ttftMs, warmTtftMs: res2.ttftMs, speedupPercent: Number(speedup.toFixed(1)) };
}

async function runSpike2ConstrainedJson() {
  console.log("\n=======================================================");
  console.log("SPIKE 2: Constrained-JSON Feasibility (oneOf schema)");
  console.log("=======================================================");

  const actionSchema = {
    name: "agent_action",
    schema: {
      type: "object",
      properties: {
        action: {
          oneOf: [
            {
              type: "object",
              properties: {
                tool: { type: "string", enum: ["read_file"] },
                path: { type: "string" }
              },
              required: ["tool", "path"],
              additionalProperties: false
            },
            {
              type: "object",
              properties: {
                tool: { type: "string", enum: ["replace_symbol"] },
                symbol: { type: "string" },
                new_source: { type: "string" }
              },
              required: ["tool", "symbol", "new_source"],
              additionalProperties: false
            }
          ]
        }
      },
      required: ["action"],
      additionalProperties: false
    }
  };

  console.log("Sending prompt with response_format json_schema (oneOf)...");
  const res = await postJson(ENDPOINT, {
    model: MODEL,
    messages: [
      {
        role: "system",
        content: "Return the requested action JSON conforming to the schema. Output only valid JSON."
      },
      {
        role: "user",
        content: "Read the file at path 'src/orders.js'."
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: actionSchema
    },
    tools: [],
    temperature: 0,
    max_tokens: 256
  });

  console.log(`Response HTTP status: ${res.status}`);
  let parsedContent = null;
  const choice = res.data?.choices?.[0]?.message;
  const content = choice?.content || "";
  console.log("Model response content:", content);

  try {
    parsedContent = JSON.parse(content);
    console.log("[SUCCESS] Successfully parsed constrained JSON with oneOf!");
    console.log("Parsed payload:", parsedContent);
  } catch (err) {
    console.log("[FAIL] Failed to parse JSON:", err.message);
  }

  return {
    supported: res.status === 200 && parsedContent !== null,
    status: res.status,
    parsed: parsedContent
  };
}

async function runSpike3PresencePenalty() {
  console.log("\n=======================================================");
  console.log("SPIKE 3: presence_penalty A/B on Exact-Copy Code Edit");
  console.log("=======================================================");

  // 150-line code snippet
  const lines = [];
  for (let i = 1; i <= 150; i++) {
    if (i === 75) {
      lines.push("  const status = 'INITIAL_STATUS';");
    } else {
      lines.push(`  function step_${i}() { return ${i} * 2; }`);
    }
  }
  const code = lines.join("\n");

  const prompt = [
    {
      role: "system",
      content:
        "You are an exact code editor. Rewrite the provided code exactly line-for-line, changing ONLY line 75: replace 'INITIAL_STATUS' with 'REVISED_STATUS'. Preserve all other 149 lines, their exact indentation, blank lines, and order with 0 drift."
    },
    {
      role: "user",
      content: `Here is the code:\n\`\`\`javascript\n${code}\n\`\`\``
    }
  ];

  console.log("Testing with presence_penalty = 0.1 (Current default)...");
  const resDefault = await postJson(ENDPOINT, {
    model: MODEL,
    messages: prompt,
    temperature: 0,
    presence_penalty: 0.1,
    max_tokens: 2048
  });

  console.log("Testing with presence_penalty = 0.0 (Target for code_edit)...");
  const resZero = await postJson(ENDPOINT, {
    model: MODEL,
    messages: prompt,
    temperature: 0,
    presence_penalty: 0.0,
    max_tokens: 2048
  });

  function countDrift(outputRaw) {
    let text = outputRaw;
    if (text.includes("```javascript")) {
      text = text.split("```javascript")[1].split("```")[0];
    } else if (text.includes("```")) {
      text = text.split("```")[1].split("```")[0];
    }
    const outLines = text.trim().split("\n");
    let drifts = 0;
    for (let i = 0; i < 150; i++) {
      const orig = lines[i];
      const actual = outLines[i];
      if (i === 74) {
        if (!actual || !actual.includes("REVISED_STATUS")) drifts++;
      } else {
        if (actual !== orig) drifts++;
      }
    }
    return { drifts, totalLinesProduced: outLines.length };
  }

  const defContent = resDefault.data?.choices?.[0]?.message?.content || "";
  const zeroContent = resZero.data?.choices?.[0]?.message?.content || "";

  const driftDefault = countDrift(defContent);
  const driftZero = countDrift(zeroContent);

  console.log(`presence_penalty: 0.1 -> Drifts: ${driftDefault.drifts} / 150`);
  console.log(`presence_penalty: 0.0 -> Drifts: ${driftZero.drifts} / 150`);

  return {
    penalty_0_1: driftDefault,
    penalty_0_0: driftZero
  };
}

async function main() {
  console.log(`Running P0 Spikes against ${ENDPOINT} (Model: ${MODEL})...`);
  const spike1 = await runSpike1PrefixCache();
  const spike2 = await runSpike2ConstrainedJson();
  const spike3 = await runSpike3PresencePenalty();

  const report = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    spike1_prefix_cache: spike1,
    spike2_constrained_json: spike2,
    spike3_presence_penalty: spike3
  };

  const fs = require("node:fs");
  const path = require("node:path");
  const outDir = path.resolve(__dirname, "../../docs/eval");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `spikes-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");

  console.log("\n=======================================================");
  console.log("P0 SPIKES COMPLETE");
  console.log(`Results written to: ${outFile}`);
  console.log("=======================================================");
}

main().catch((err) => {
  console.error("Spike runner error:", err);
  process.exit(1);
});
