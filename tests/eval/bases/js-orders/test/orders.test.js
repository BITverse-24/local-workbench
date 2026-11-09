import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterOrdersByStatus,
  calculateOrderTotal,
  applyDiscount,
  isEligibleForFreeShipping,
  findOrderById
} from "../src/orders.js";

test("filterOrdersByStatus filters correctly", () => {
  const orders = [
    { id: 1, status: "pending" },
    { id: 2, status: "completed" },
    { id: 3, status: "pending" }
  ];
  const pending = filterOrdersByStatus(orders, "pending");
  assert.equal(pending.length, 2);
  assert.equal(pending[0].id, 1);
  assert.equal(pending[1].id, 3);
});

test("calculateOrderTotal sums item prices times quantities", () => {
  const items = [
    { price: 10, quantity: 2 },
    { price: 5, quantity: 4 }
  ];
  assert.equal(calculateOrderTotal(items), 40);
});

test("applyDiscount calculates percentage discounts properly", () => {
  assert.equal(applyDiscount(100, 20), 80);
  assert.equal(applyDiscount(50, 0), 50);
  assert.equal(applyDiscount(100, 110), 0);
});

test("isEligibleForFreeShipping checks threshold boundary", () => {
  assert.equal(isEligibleForFreeShipping(50, 50), true);
  assert.equal(isEligibleForFreeShipping(49.99, 50), false);
  assert.equal(isEligibleForFreeShipping(100, 50), true);
});

test("findOrderById returns order or null", () => {
  const orders = [{ id: "A1", status: "open" }];
  assert.deepEqual(findOrderById(orders, "A1"), { id: "A1", status: "open" });
  assert.equal(findOrderById(orders, "B2"), null);
});
