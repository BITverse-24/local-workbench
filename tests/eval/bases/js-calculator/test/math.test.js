import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateMean,
  calculateMedian,
  clamp,
  standardDeviation,
  factorial
} from "../src/math.js";

test("calculateMean computes average correctly", () => {
  assert.equal(calculateMean([2, 4, 6, 8]), 5);
  assert.equal(calculateMean([]), 0);
});

test("calculateMedian handles odd and even arrays", () => {
  assert.equal(calculateMedian([7, 1, 3]), 3);
  assert.equal(calculateMedian([1, 2, 3, 4]), 2.5);
  assert.equal(calculateMedian([]), 0);
});

test("clamp keeps values within bounds", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});

test("standardDeviation computes population std dev", () => {
  const sd = standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.ok(Math.abs(sd - 2.0) < 0.001);
});

test("factorial computes products", () => {
  assert.equal(factorial(0), 1);
  assert.equal(factorial(1), 1);
  assert.equal(factorial(5), 120);
});
