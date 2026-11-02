import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkOrders, saveWorkOrders, STORAGE_KEY } from "../src/storage.js";

function memoryStorage(saved = null) {
  return {
    getItem: () => saved,
    setItem(key, value) { this.key = key; this.value = value; },
  };
}

const fallback = [{ id: "WO-default", title: "Starter order", site: "North Yard", priority: "Low", status: "open" }];

test("missing saved data uses starter work orders", () => {
  assert.deepEqual(loadWorkOrders(memoryStorage(), fallback), fallback);
});

test("valid saved work orders are restored", () => {
  const saved = [{ ...fallback[0], status: "closed" }];
  assert.deepEqual(loadWorkOrders(memoryStorage(JSON.stringify(saved)), fallback), saved);
});

test("malformed saved data falls back to starter work orders", () => {
  assert.deepEqual(loadWorkOrders(memoryStorage("{broken"), fallback), fallback);
});

test("saved data with the wrong shape falls back to starter work orders", () => {
  assert.deepEqual(loadWorkOrders(memoryStorage(JSON.stringify({ orders: fallback })), fallback), fallback);
});

test("saved arrays with invalid work orders fall back to starter work orders", () => {
  assert.deepEqual(loadWorkOrders(memoryStorage(JSON.stringify([null])), fallback), fallback);
});

test("work orders are saved under the app key", () => {
  const storage = memoryStorage();
  saveWorkOrders(storage, fallback);
  assert.equal(storage.key, STORAGE_KEY);
  assert.deepEqual(JSON.parse(storage.value), fallback);
});
