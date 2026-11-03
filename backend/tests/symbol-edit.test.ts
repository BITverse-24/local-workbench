import { describe, it, expect } from "vitest";
import { bindSymbolEdit } from "../src/main/agent/symbol-edit.js";
import type { AgentRepairSource } from "../src/main/agent/repair-proposal.js";
import type { AgentToolCall } from "../src/shared/contracts.js";

describe("symbol-edit", () => {
  const jsSourceText = `
export function calculateTax(amount, rate) {
  return amount * rate;
}

export class OrderManager {
  constructor(taxRate) {
    this.taxRate = taxRate;
  }

  processOrder(total) {
    return total - 1;
  }
}
`;
  const jsBytes = Buffer.from(jsSourceText, "utf8");
  const jsRepairSource: AgentRepairSource = {
    path: "src/orders.js",
    digest: "a".repeat(64),
    focusKey: "src/orders.js",
    expanded: false,
    completeSource: jsSourceText
  };

  it("lowers valid JS function replacement to edit_file", async () => {
    const call: AgentToolCall = {
      id: "call-1",
      name: "replace_symbol",
      arguments: {
        edits: [
          {
            symbol: "calculateTax",
            new_source: "function calculateTax(amount, rate) {\n  return amount * (rate + 0.01);\n}"
          }
        ]
      }
    };

    const res = await bindSymbolEdit(call, jsRepairSource, jsBytes);
    expect("call" in res).toBe(true);
    if (!("call" in res)) return;

    expect(res.call.name).toBe("edit_file");
    const args = res.call.arguments as any;
    expect(args.path).toBe("src/orders.js");
    expect(args.expected_digest).toBe("a".repeat(64));
    expect(args.replacements).toHaveLength(1);
    expect(args.replacements[0].old).toBe("function calculateTax(amount, rate) {\n  return amount * rate;\n}");
    expect(args.replacements[0].new).toBe("function calculateTax(amount, rate) {\n  return amount * (rate + 0.01);\n}");
  });

  it("lowers valid JS class method replacement to edit_file", async () => {
    const call: AgentToolCall = {
      id: "call-2",
      name: "replace_symbol",
      arguments: {
        edits: [
          {
            symbol: "OrderManager.processOrder",
            new_source: "processOrder(total) {\n    return total * (1 + this.taxRate);\n  }"
          }
        ]
      }
    };

    const res = await bindSymbolEdit(call, jsRepairSource, jsBytes);
    expect("call" in res).toBe(true);
    if (!("call" in res)) return;

    const args = res.call.arguments as any;
    expect(args.replacements[0].old).toBe("processOrder(total) {\n    return total - 1;\n  }");
    expect(args.replacements[0].new).toBe("processOrder(total) {\n    return total * (1 + this.taxRate);\n  }");
  });

  it("strips accidental markdown code fences in new_source", async () => {
    const call: AgentToolCall = {
      id: "call-3",
      name: "replace_symbol",
      arguments: {
        edits: [
          {
            symbol: "calculateTax",
            new_source: "```javascript\nfunction calculateTax(amount, rate) {\n  return amount * rate;\n}\n```"
          }
        ]
      }
    };

    const res = await bindSymbolEdit(call, jsRepairSource, jsBytes);
    expect("call" in res).toBe(true);
    if (!("call" in res)) return;
    const args = res.call.arguments as any;
    expect(args.replacements[0].new).toBe("function calculateTax(amount, rate) {\n  return amount * rate;\n}");
  });

  it("rejects unknown symbol and lists available symbols", async () => {
    const call: AgentToolCall = {
      id: "call-4",
      name: "replace_symbol",
      arguments: {
        edits: [{ symbol: "nonExistentFunction", new_source: "function nonExistentFunction() {}" }]
      }
    };

    await expect(bindSymbolEdit(call, jsRepairSource, jsBytes)).rejects.toThrow(/Available symbols/);
  });

  it("rejects replacement with mismatched name", async () => {
    const call: AgentToolCall = {
      id: "call-5",
      name: "replace_symbol",
      arguments: {
        edits: [{ symbol: "calculateTax", new_source: "function wrongName(amount, rate) {}" }]
      }
    };

    await expect(bindSymbolEdit(call, jsRepairSource, jsBytes)).rejects.toThrow(/does not match target/);
  });

  it("handles blocked_reason and context_needed without errors", async () => {
    const blockedCall: AgentToolCall = {
      id: "call-6",
      name: "replace_symbol",
      arguments: { blocked_reason: "Cannot determine correct formula." }
    };
    const resBlocked = await bindSymbolEdit(blockedCall, jsRepairSource, jsBytes);
    expect(resBlocked).toEqual({ blocked: "Cannot determine correct formula." });

    const contextCall: AgentToolCall = {
      id: "call-7",
      name: "replace_symbol",
      arguments: { context_needed: "Need to inspect config.js." }
    };
    const resContext = await bindSymbolEdit(contextCall, jsRepairSource, jsBytes);
    expect(resContext).toEqual({ contextNeeded: "Need to inspect config.js." });
  });

  it("lowers Python method edit and rebases indentation", async () => {
    const pySource = `
class Calculator:
    def __init__(self):
        self.val = 0

    def add(self, x):
        return self.val - x
`;
    const pyBytes = Buffer.from(pySource, "utf8");
    const pyRepairSource: AgentRepairSource = {
      path: "calc.py",
      digest: "b".repeat(64),
      focusKey: "calc.py",
      expanded: false,
      completeSource: pySource
    };

    const call: AgentToolCall = {
      id: "call-py-1",
      name: "replace_symbol",
      arguments: {
        edits: [
          {
            symbol: "Calculator.add",
            new_source: "def add(self, x):\n    return self.val + x"
          }
        ]
      }
    };

    const res = await bindSymbolEdit(call, pyRepairSource, pyBytes);
    expect("call" in res).toBe(true);
    if (!("call" in res)) return;

    const args = res.call.arguments as any;
    expect(args.path).toBe("calc.py");
    // Indentation of new_source should be rebased to 4 spaces
    expect(args.replacements[0].new).toBe("    def add(self, x):\n        return self.val + x");
    expect(args.replacements[0].old.includes("def add(self, x):")).toBe(true);
  });
});
