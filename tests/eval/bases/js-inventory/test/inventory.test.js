import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getLowStockItems,
  adjustStock,
  totalInventoryValue,
  categorizeInventory,
  restockNeeds
} from "../src/inventory.js";

test("getLowStockItems returns items below or at threshold", () => {
  const items = [
    { sku: "A", quantity: 3 },
    { sku: "B", quantity: 10 },
    { sku: "C", quantity: 5 }
  ];
  const low = getLowStockItems(items, 5);
  assert.equal(low.length, 2);
  assert.equal(low[0].sku, "A");
  assert.equal(low[1].sku, "C");
});

test("adjustStock updates quantity or throws on negative", () => {
  const item = { sku: "X", quantity: 15 };
  const updated = adjustStock(item, -5);
  assert.equal(updated.quantity, 10);
  assert.throws(() => adjustStock(item, -20), /Insufficient stock/);
});

test("totalInventoryValue calculates aggregate cost", () => {
  const items = [
    { sku: "M", cost: 10, quantity: 4 },
    { sku: "N", cost: 25, quantity: 2 }
  ];
  assert.equal(totalInventoryValue(items), 90);
});

test("categorizeInventory groups by category", () => {
  const items = [
    { sku: "P1", category: "tools" },
    { sku: "P2", category: "hardware" },
    { sku: "P3", category: "tools" }
  ];
  const groups = categorizeInventory(items);
  assert.equal(groups.tools.length, 2);
  assert.equal(groups.hardware.length, 1);
});

test("restockNeeds computes quantity deficits", () => {
  const items = [
    { sku: "S1", quantity: 5 },
    { sku: "S2", quantity: 25 }
  ];
  const needs = restockNeeds(items, 20);
  assert.deepEqual(needs, [{ sku: "S1", needed: 15 }]);
});
