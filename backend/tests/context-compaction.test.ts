import { describe, expect, it } from "vitest";
import {
  compactConversationHistory,
  compactToolObservation,
  compactToolResult,
  extractSourceArg,
  GLOBAL_SAFETY_LIMIT,
  OLDER_ASSISTANT_BUDGET,
  OLDER_TOOL_BUDGETS,
  TOOL_OBSERVATION_BUDGETS,
  type AgentMessage,
} from "../src/main/agent/context-manager.js";
import { formatMessagesForNativeTools } from "../src/main/gateway/model-gateway.js";

describe("P0-01: Context Compaction & Deterministic Budgeting Specification", () => {
  // ── 1. Single-Line JSON (175,903 chars audit case) ──────────────────────────
  it("bounds 175,903-character single-line JSON without escaping compaction", () => {
    // Construct single-line JSON with exactly 175,903 characters
    const prefix = '{"status":"success","data":[';
    const suffix = '],"total":9999}';
    const targetLength = 175903;
    const fillLength = targetLength - prefix.length - suffix.length;
    const filler = "x".repeat(fillLength);
    const singleLineJson = `${prefix}${filler}${suffix}`;

    expect(singleLineJson.length).toBe(175903);
    expect(singleLineJson.includes("\n")).toBe(false);

    const messages: AgentMessage[] = [
      { role: "system", content: "You are an industrial engineering agent." },
      { role: "user", content: "Analyze the pressure inspection telemetry data." },
      {
        role: "assistant",
        content: "I will read the raw report JSON.",
        tool_calls: [{ id: "call_json_1", type: "function", function: { name: "read_file", arguments: '{"path":"report.json"}' } }],
        turn: 1,
      },
      {
        role: "tool",
        tool_call_id: "call_json_1",
        toolName: "read_file",
        source: "report.json",
        content: singleLineJson,
        turn: 1,
      },
      {
        role: "assistant",
        content: "Now reading the latest telemetry snapshot.",
        tool_calls: [{ id: "call_json_2", type: "function", function: { name: "read_file", arguments: '{"path":"live.json"}' } }],
        turn: 3,
      },
      {
        role: "tool",
        tool_call_id: "call_json_2",
        toolName: "read_file",
        source: "live.json",
        content: singleLineJson,
        turn: 3,
      },
    ];

    // Current turn is 3, keepFullTurns is 1. Turn 1 is older; Turn 3 is recent.
    const compacted = compactConversationHistory(messages, 3, 1);

    // Older turn tool observation (Turn 1):
    const oldToolMsg = compacted[3];
    expect(oldToolMsg.role).toBe("tool");
    expect(oldToolMsg.content).toBeDefined();
    expect(oldToolMsg.content!.length).toBeLessThanOrEqual(OLDER_TOOL_BUDGETS.read_file); // <= 4000
    expect(oldToolMsg.content!.length).toBeLessThanOrEqual(GLOBAL_SAFETY_LIMIT);
    expect(oldToolMsg.compaction).toBeDefined();
    expect(oldToolMsg.compaction?.truncated).toBe(true);
    expect(oldToolMsg.compaction?.originalChars).toBe(175903);
    expect(oldToolMsg.compaction?.toolName).toBe("read_file");
    expect(oldToolMsg.compaction?.source).toBe("report.json");
    // Verify raw observation is preserved in memory for recoverability
    expect(oldToolMsg.rawContent).toBe(singleLineJson);

    // Recent turn tool observation (Turn 3):
    // Even though it is on a recent turn, it must NOT enter next invocation unbounded (8,000 cap)!
    const recentToolMsg = compacted[5];
    expect(recentToolMsg.role).toBe("tool");
    expect(recentToolMsg.content).toBeDefined();
    expect(recentToolMsg.content!.length).toBeLessThanOrEqual(TOOL_OBSERVATION_BUDGETS.read_file); // <= 8000
    expect(recentToolMsg.content!.length).toBeLessThanOrEqual(GLOBAL_SAFETY_LIMIT);
    expect(recentToolMsg.compaction?.truncated).toBe(true);
    expect(recentToolMsg.compaction?.originalChars).toBe(175903);
    expect(recentToolMsg.compaction?.toolName).toBe("read_file");
    expect(recentToolMsg.compaction?.source).toBe("live.json");

    // Compaction notice must be explicitly visible in the model-facing text
    expect(recentToolMsg.content).toContain("[OBSERVATION COMPACTED: Truncated to fit context budget]");
    expect(recentToolMsg.content).toContain('"truncated": true');
    expect(recentToolMsg.content).toContain('"source": "live.json"');
  });

  // ── 2. 200KB Minified Text (Unconditional Safety Cap) ───────────────────────
  it("enforces strict budgets on 200KB minified text without newlines across multiple tools", () => {
    const minified200k = "const a=1;function run(){return 'x'.repeat(10);}".repeat(4000); // ~200KB
    expect(minified200k.length).toBeGreaterThanOrEqual(190000);

    // A. search tool (budget: 4,000 recent, 2,000 older)
    const searchResRecent = compactToolObservation({
      content: minified200k,
      toolName: "search",
      source: "pattern: run",
      isOlderTurn: false,
    });
    expect(searchResRecent.content.length).toBeLessThanOrEqual(TOOL_OBSERVATION_BUDGETS.search);
    expect(searchResRecent.metadata.truncated).toBe(true);
    expect(searchResRecent.metadata.toolName).toBe("search");
    expect(searchResRecent.metadata.source).toBe("pattern: run");

    const searchResOlder = compactToolObservation({
      content: minified200k,
      toolName: "search",
      source: "pattern: run",
      isOlderTurn: true,
    });
    expect(searchResOlder.content.length).toBeLessThanOrEqual(OLDER_TOOL_BUDGETS.search);

    // B. run_command tool (budget: 3,000 recent, 1,500 older)
    const cmdResRecent = compactToolObservation({
      content: minified200k,
      toolName: "run_command",
      source: "pytest -v",
      isOlderTurn: false,
    });
    expect(cmdResRecent.content.length).toBeLessThanOrEqual(TOOL_OBSERVATION_BUDGETS.run_command);
    expect(cmdResRecent.content.length).toBeLessThanOrEqual(3000);

    const cmdResOlder = compactToolObservation({
      content: minified200k,
      toolName: "run_command",
      source: "pytest -v",
      isOlderTurn: true,
    });
    expect(cmdResOlder.content.length).toBeLessThanOrEqual(OLDER_TOOL_BUDGETS.run_command);
    expect(cmdResOlder.content.length).toBeLessThanOrEqual(1500);

    // C. No control flow branch can bypass the global safety limit (8,000 chars)
    const bypassAttempt = compactToolObservation({
      content: minified200k,
      toolName: "custom_unbounded_tool",
      isOlderTurn: false,
      maxBudget: 999999, // Attempt to request an unbounded budget
    });
    expect(bypassAttempt.content.length).toBeLessThanOrEqual(GLOBAL_SAFETY_LIMIT);
  });

  // ── 3. Multiline Tables & Fact Preservation (extract_document) ───────────────
  it("preserves 60+ fact lines in extract_document without premature 400-char truncation", () => {
    // A table within the 4,000 char budget (e.g. 40 rows, ~2,800 chars)
    const fitFactLines: string[] = [
      "| Item | Location | Measured (mm) | Allowable (mm) | Status | Defect Type |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
    ];
    for (let i = 1; i <= 40; i++) {
      const thickness = (3.2 + (i % 5) * 0.1).toFixed(2);
      const status = i === 14 ? "NON-COMPLIANT" : "COMPLIANT";
      fitFactLines.push(`| Row ${i.toString().padStart(2, "0")} | Tube-Sec-${i} | ${thickness} mm | 3.00 mm | ${status} | Pit-${i % 3} |`);
    }
    const fitTableText = fitFactLines.join("\n");
    expect(fitTableText.length).toBeLessThan(4000);

    // In the old implementation, compactToolResult("extract_document") called truncateChars(400),
    // which threw away 35 of the 42 rows!
    // With P0-01, extract_document has a 4,000 character budget.
    const resWithinBudget = compactToolObservation({
      content: fitTableText,
      toolName: "extract_document",
      source: "inspection-report.pdf",
      isOlderTurn: false,
    });
    expect(resWithinBudget.content).toBe(fitTableText);
    expect(resWithinBudget.metadata.truncated).toBe(false);
    expect(resWithinBudget.content.split("\n").length).toBe(42);

    // Now test a 60-row fact table (~4,600 chars) exceeding 4,000 chars:
    // In old code: truncateChars(400) retained only 11 lines!
    // In new code: retains ~48 lines at clean newline boundaries, bounded to <= 4,000 chars!
    const factLines60: string[] = [
      "| Item | Location | Measured (mm) | Allowable (mm) | Status | Defect Type |",
      "| :--- | :--- | :--- | :--- | :--- | :--- |",
    ];
    for (let i = 1; i <= 60; i++) {
      const thickness = (3.2 + (i % 5) * 0.1).toFixed(2);
      const status = i === 14 || i === 42 ? "NON-COMPLIANT" : "COMPLIANT";
      factLines60.push(`| Row ${i.toString().padStart(2, "0")} | Tube-Section-${i} | ${thickness} mm | 3.00 mm | ${status} | Pit-Grade-${i % 3} |`);
    }
    const table60Text = factLines60.join("\n");

    const res60 = compactToolObservation({
      content: table60Text,
      toolName: "extract_document",
      source: "inspection-report.pdf",
      isOlderTurn: false,
    });

    expect(res60.content.length).toBeLessThanOrEqual(4000);
    expect(res60.metadata.truncated).toBe(true);
    // Retains significantly more lines than the old 11 lines (retains ~48 lines)
    const retainedLines = res60.content.split("\n").filter((l) => l.startsWith("| Row "));
    expect(retainedLines.length).toBeGreaterThan(40);
    expect(res60.content).toContain("| Row 01 |");
    expect(res60.content).toContain("| Row 60 |");

    // Now test a massive 250-row multiline table (> 12,000 characters)
    const massiveRows: string[] = [
      "| Item | Parameter | Value | Status |",
      "| :--- | :--- | :--- | :--- |",
    ];
    for (let i = 1; i <= 250; i++) {
      massiveRows.push(`| Node-${i} | Pressure-Check-${i} | ${(100 + i * 0.5).toFixed(1)} bar | VERIFIED |`);
    }
    const massiveTable = massiveRows.join("\n");
    expect(massiveTable.length).toBeGreaterThan(10000);

    const resMassive = compactToolObservation({
      content: massiveTable,
      toolName: "extract_document",
      source: "large-drawing.svg",
      isOlderTurn: false,
    });

    // Bounded to 4,000 character budget
    expect(resMassive.content.length).toBeLessThanOrEqual(4000);
    expect(resMassive.metadata.truncated).toBe(true);
    // Multiline partitioning must preserve clean line boundaries without mid-word slicing
    expect(resMassive.content).toContain("| Node-1 | Pressure-Check-1 |");
    expect(resMassive.content).toContain("| Node-250 | Pressure-Check-250 |");
    expect(resMassive.content).toContain("compacted");
  });

  // ── 4. Old vs Recent Observations ───────────────────────────────────────────
  it("enforces differential sliding-window budgets across older and recent turns", () => {
    const output50k = "LINE DATA - RECORD ITEM ".repeat(2000); // ~48KB
    const shortOutput = "Short result within budget (150 chars).";

    const messages: AgentMessage[] = [
      { role: "system", content: "System base instructions." },
      { role: "user", content: "Run diagnostic inspection." },
      // Turn 1 (Old)
      { role: "assistant", content: "Checking file A", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }], turn: 1 },
      { role: "tool", tool_call_id: "c1", toolName: "read_file", source: "a.txt", content: output50k, turn: 1 },
      // Turn 2 (Old)
      { role: "assistant", content: "Checking file B", tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } }], turn: 2 },
      { role: "tool", tool_call_id: "c2", toolName: "read_file", source: "b.txt", content: shortOutput, turn: 2 },
      // Turn 4 (Recent)
      { role: "assistant", content: "Checking file C", tool_calls: [{ id: "c3", type: "function", function: { name: "read_file", arguments: '{"path":"c.txt"}' } }], turn: 4 },
      { role: "tool", tool_call_id: "c3", toolName: "read_file", source: "c.txt", content: output50k, turn: 4 },
      // Turn 5 (Recent)
      { role: "assistant", content: "Checking file D", tool_calls: [{ id: "c4", type: "function", function: { name: "read_file", arguments: '{"path":"d.txt"}' } }], turn: 5 },
      { role: "tool", tool_call_id: "c4", toolName: "read_file", source: "d.txt", content: shortOutput, turn: 5 },
    ];

    // Current turn is 5, keepFullTurns = 2. Cutoff turn is 5 - 2 = 3.
    // Turns 1 and 2 are OLD. Turns 4 and 5 are RECENT.
    const compacted = compactConversationHistory(messages, 5, 2);

    // Turn 1 (Old 50KB): compacted to older budget (<= 4000)
    const turn1Tool = compacted[3];
    expect(turn1Tool.content!.length).toBeLessThanOrEqual(4000);
    expect(turn1Tool.compaction?.truncated).toBe(true);

    // Turn 2 (Old short): short output within budget is preserved
    const turn2Tool = compacted[5];
    expect(turn2Tool.content).toBe(shortOutput);

    // Turn 4 (Recent 50KB): bounded to recent observation budget (<= 8000), not left unbounded
    const turn4Tool = compacted[7];
    expect(turn4Tool.content!.length).toBeLessThanOrEqual(8000);
    expect(turn4Tool.compaction?.truncated).toBe(true);

    // Turn 5 (Recent short): fully preserved
    const turn5Tool = compacted[9];
    expect(turn5Tool.content).toBe(shortOutput);
  });

  // ── 5. Oversized Assistant Messages ─────────────────────────────────────────
  it("bounds older assistant messages while strictly preserving tool_calls continuity", () => {
    const oversizedThinking = "Scratchpad reasoning step: evaluating pressure valve telemetry and flow rates.\n".repeat(300); // ~24KB
    expect(oversizedThinking.length).toBeGreaterThan(20000);

    const messages: AgentMessage[] = [
      { role: "system", content: "CRITICAL SYSTEM DIRECTIVE: air-gapped operations only." },
      { role: "user", content: "Please generate the compliance review note for P-204." },
      // Turn 1 (Older turn with oversized assistant thinking and tool_calls)
      {
        role: "assistant",
        content: oversizedThinking,
        tool_calls: [
          {
            id: "call_turn1_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"specs.md"}' },
          },
        ],
        turn: 1,
      },
      {
        role: "tool",
        tool_call_id: "call_turn1_1",
        toolName: "read_file",
        source: "specs.md",
        content: "specs content line 1\nline 2",
        turn: 1,
      },
      // Turn 4 (Recent turn with moderate thinking)
      {
        role: "assistant",
        content: "Evaluating observed values against specs: valve rating is compliant.",
        tool_calls: [
          {
            id: "call_turn4_1",
            type: "function",
            function: { name: "generate_deliverable", arguments: '{"filename":"note.docx"}' },
          },
        ],
        turn: 4,
      },
      {
        role: "tool",
        tool_call_id: "call_turn4_1",
        toolName: "generate_deliverable",
        content: "File generated successfully",
        turn: 4,
      },
    ];

    // Current turn is 4, keepFullTurns is 2. Turn 1 is <= 4 - 2 = 2 (older turn).
    const compacted = compactConversationHistory(messages, 4, 2);

    // 1. System prompt MUST be 100% intact
    expect(compacted[0].content).toBe("CRITICAL SYSTEM DIRECTIVE: air-gapped operations only.");

    // 2. User prompt MUST be 100% intact
    expect(compacted[1].content).toBe("Please generate the compliance review note for P-204.");

    // 3. Turn 1 Assistant message: content bounded to <= OLDER_ASSISTANT_BUDGET
    const oldAssistant = compacted[2];
    expect(oldAssistant.role).toBe("assistant");
    expect(oldAssistant.content!.length).toBeLessThanOrEqual(OLDER_ASSISTANT_BUDGET + 200);
    expect(oldAssistant.content).toContain("compacted");
    expect(oldAssistant.content).toContain("assistant thinking");
    expect(oldAssistant.compaction?.truncated).toBe(true);

    // CRITICAL: tool_calls must NOT be stripped or damaged!
    expect(oldAssistant.tool_calls).toHaveLength(1);
    expect(oldAssistant.tool_calls![0].id).toBe("call_turn1_1");
    expect(oldAssistant.tool_calls![0].function.name).toBe("read_file");

    // 4. Corresponding tool message remains paired
    const oldTool = compacted[3];
    expect(oldTool.tool_call_id).toBe("call_turn1_1");

    // 5. Recent assistant message is preserved in full
    expect(compacted[4].content).toBe("Evaluating observed values against specs: valve rating is compliant.");
    expect(compacted[4].tool_calls![0].id).toBe("call_turn4_1");
  });

  // ── 6. Multi-Tool Conversation History & Gateway Compatibility ──────────────
  it("preserves conversation sequence and gateway schema validity across multi-tool chains", () => {
    const hugeOutput = "A".repeat(25000);

    const messages: AgentMessage[] = [
      { role: "system", content: "You are Sovereign Workbench." },
      { role: "user", content: "Inspect codebase and fix reactor log parsing." },
      // Step 1: list_dir
      {
        role: "assistant",
        content: "Listing workspace files.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } }],
        turn: 1,
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        toolName: "list_dir",
        source: ".",
        content: hugeOutput,
        turn: 1,
      },
      // Step 2: search
      {
        role: "assistant",
        content: "Searching for parse_logs definition.",
        tool_calls: [{ id: "call_2", type: "function", function: { name: "search", arguments: '{"query":"parse_logs"}' } }],
        turn: 2,
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        toolName: "search",
        source: "parse_logs",
        content: hugeOutput,
        turn: 2,
      },
      // Step 3: read_file
      {
        role: "assistant",
        content: "Reading parser script.",
        tool_calls: [{ id: "call_3", type: "function", function: { name: "read_file", arguments: '{"path":"parser.py"}' } }],
        turn: 3,
      },
      {
        role: "tool",
        tool_call_id: "call_3",
        toolName: "read_file",
        source: "parser.py",
        content: hugeOutput,
        turn: 3,
      },
      // Step 4: run_command
      {
        role: "assistant",
        content: "Running test runner.",
        tool_calls: [{ id: "call_4", type: "function", function: { name: "run_command", arguments: '{"command":"python3 -m unittest"}' } }],
        turn: 4,
      },
      {
        role: "tool",
        tool_call_id: "call_4",
        toolName: "run_command",
        source: "python3 -m unittest",
        content: hugeOutput,
        turn: 4,
      },
    ];

    // Current turn is 4, keepFullTurns is 1. Turns 1, 2, 3 are old; Turn 4 is recent.
    const compacted = compactConversationHistory(messages, 4, 1);

    // Verify all tool results are bounded
    for (const msg of compacted) {
      if (msg.role === "tool") {
        expect(msg.content!.length).toBeLessThanOrEqual(GLOBAL_SAFETY_LIMIT);
        expect(msg.compaction?.truncated).toBe(true);
      }
    }

    // Pass the compacted messages through model-gateway's formatMessagesForNativeTools
    const formattedNative = formatMessagesForNativeTools(compacted);
    expect(formattedNative).toHaveLength(messages.length);

    // Verify OpenAI-compatible structure:
    // Every assistant with tool_calls must be directly followed by tool messages with matching tool_call_id
    for (let i = 0; i < formattedNative.length; i++) {
      const current = formattedNative[i];
      if (current.role === "assistant" && current.tool_calls) {
        const toolCall = current.tool_calls[0];
        const nextMessage = formattedNative[i + 1];
        expect(nextMessage).toBeDefined();
        expect(nextMessage.role).toBe("tool");
        expect(nextMessage.tool_call_id).toBe(toolCall.id);
        expect(typeof nextMessage.content).toBe("string");
        expect(nextMessage.content.length).toBeLessThanOrEqual(GLOBAL_SAFETY_LIMIT);
      }
    }
  });

  // ── 7. Source Extraction & Compaction Helper Utilities ──────────────────────
  it("extracts source arguments reliably across varied caller shapes", () => {
    expect(extractSourceArg("read_file", { path: "src/engine.ts" })).toBe("src/engine.ts");
    expect(extractSourceArg("extract_document", { filename: "report.pdf" })).toBe("report.pdf");
    expect(extractSourceArg("extract_document", { document: "drawing.svg" })).toBe("drawing.svg");
    expect(extractSourceArg("run_command", { command: "cargo test" })).toBe("cargo test");
    expect(extractSourceArg("search", { query: "SOP-114" })).toBe("SOP-114");
    expect(extractSourceArg("search", { search_query: "valve rating" })).toBe("valve rating");
    expect(extractSourceArg("unknown_tool", {})).toBe("");
    expect(extractSourceArg("unknown_tool", null)).toBe("");
  });

  it("compactToolResult produces deterministic bounded output with metadata notice", () => {
    const raw = "Sample log output line\n".repeat(500); // ~11KB
    const compacted = compactToolResult(raw, "read_file", "server.log");
    expect(compacted.length).toBeLessThanOrEqual(OLDER_TOOL_BUDGETS.read_file);
    expect(compacted).toContain("[OBSERVATION COMPACTED: Truncated to fit context budget]");
    expect(compacted).toContain('"source": "server.log"');
    expect(compacted).toContain('"toolName": "read_file"');
  });
});
