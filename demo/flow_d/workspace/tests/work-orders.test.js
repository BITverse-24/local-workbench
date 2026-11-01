import test from "node:test";
import assert from "node:assert/strict";
import { changeWorkOrderStatus, filterWorkOrders } from "../src/work-orders.js";

const orders = [
  { id: "WO-1", title: "Dock seal", site: "North Yard", status: "open" },
  { id: "WO-2", title: "Pump inspection", site: "East Annex", status: "in-progress" },
  { id: "WO-3", title: "Gate sensor", site: "North Yard", status: "closed" },
];

test("status filter returns only matching work orders", () => {
  assert.deepEqual(filterWorkOrders(orders, { status: "open" }).map((order) => order.id), ["WO-1"]);
});

test("search is case-insensitive across IDs, titles, and sites", () => {
  assert.deepEqual(filterWorkOrders(orders, { query: "east" }).map((order) => order.id), ["WO-2"]);
  assert.deepEqual(filterWorkOrders(orders, { query: "wo-3" }).map((order) => order.id), ["WO-3"]);
});

test("status and search filters apply together", () => {
  assert.deepEqual(filterWorkOrders(orders, { status: "open", query: "north" }).map((order) => order.id), ["WO-1"]);
  assert.deepEqual(filterWorkOrders(orders, { status: "closed", query: "north" }).map((order) => order.id), ["WO-3"]);
});

test("changing status returns a new list and keeps other orders intact", () => {
  const changed = changeWorkOrderStatus(orders, "WO-1", "closed");
  assert.equal(changed[0].status, "closed");
  assert.equal(orders[0].status, "open");
  assert.deepEqual(changed[1], orders[1]);
});
