import { describe, it, expect } from "vitest";
import { indexSymbols } from "../src/main/agent/symbol-index.js";

describe("symbol-index", () => {
  it("indexes JS functions, classes, methods, and variable functions", async () => {
    const code = `
function helper(a, b) {
  return a + b;
}

export function parseItem(item) {
  return item.trim();
}

export const formatItem = (item) => {
  return item.toUpperCase();
};

export class OrderProcessor {
  constructor(taxRate) {
    this.taxRate = taxRate;
  }

  process(order) {
    return order.total * (1 + this.taxRate);
  }

  static defaultRate() {
    return 0.05;
  }
}

export default function main() {
  return 42;
}
`;
    const bytes = Buffer.from(code, "utf8");
    const symbols = await indexSymbols("orders.js", bytes);

    const names = symbols.map(s => s.name);
    expect(names).toContain("helper");
    expect(names).toContain("parseItem");
    expect(names).toContain("formatItem");
    expect(names).toContain("OrderProcessor");
    expect(names).toContain("OrderProcessor.constructor");
    expect(names).toContain("OrderProcessor.process");
    expect(names).toContain("OrderProcessor.defaultRate");
    expect(names).toContain("main");

    // Check parseItem symbol slice
    const parseItem = symbols.find(s => s.name === "parseItem")!;
    expect(parseItem.exported).toBe(true);
    expect(parseItem.kind).toBe("function");
    const slice = bytes.subarray(parseItem.startByte, parseItem.endByte).toString("utf8");
    // Should start with 'function', not 'export function'
    expect(slice.startsWith("function parseItem")).toBe(true);

    // Check method slice
    const processMethod = symbols.find(s => s.name === "OrderProcessor.process")!;
    expect(processMethod.kind).toBe("method");
    const methodSlice = bytes.subarray(processMethod.startByte, processMethod.endByte).toString("utf8");
    expect(methodSlice.startsWith("process(order)")).toBe(true);
  });

  it("indexes TS functions with types and generics", async () => {
    const code = `
export function identity<T>(value: T): T {
  return value;
}

export class Container<T> {
  private item: T;
  constructor(item: T) {
    this.item = item;
  }
  public get(): T {
    return this.item;
  }
}
`;
    const bytes = Buffer.from(code, "utf8");
    const symbols = await indexSymbols("types.ts", bytes);

    expect(symbols.map(s => s.name)).toEqual([
      "identity",
      "Container",
      "Container.constructor",
      "Container.get"
    ]);
  });

  it("indexes Python functions, classes, and indented methods", async () => {
    const code = `
import os

def calculate_discount(price, rate):
    return price * (1 - rate)

class InventoryStore:
    def __init__(self, capacity):
        self.capacity = capacity
        self.items = []

    def add_item(self, item):
        if len(self.items) < self.capacity:
            self.items.append(item)
            return True
        return False
`;
    const bytes = Buffer.from(code, "utf8");
    const symbols = await indexSymbols("store.py", bytes);

    if (symbols.length === 0) {
      // Python not available in this env
      return;
    }

    const names = symbols.map(s => s.name);
    expect(names).toContain("calculate_discount");
    expect(names).toContain("InventoryStore");
    expect(names).toContain("InventoryStore.__init__");
    expect(names).toContain("InventoryStore.add_item");

    const func = symbols.find(s => s.name === "calculate_discount")!;
    expect(func.kind).toBe("function");
    expect(func.col).toBe(0);
    const funcSlice = bytes.subarray(func.startByte, func.endByte).toString("utf8");
    expect(funcSlice.startsWith("def calculate_discount")).toBe(true);

    const method = symbols.find(s => s.name === "InventoryStore.add_item")!;
    expect(method.kind).toBe("method");
    expect(method.col).toBe(4);
    const methodSlice = bytes.subarray(method.startByte, method.endByte).toString("utf8");
    // Contains leading 4 spaces
    expect(methodSlice.includes("def add_item(self, item):")).toBe(true);
  });
});
