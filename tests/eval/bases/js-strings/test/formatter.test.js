import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toSlug,
  truncate,
  camelToKebab,
  capitalizeWords,
  renderTemplate
} from "../src/formatter.js";

test("toSlug creates URL-friendly slugs", () => {
  assert.equal(toSlug("Hello World! 2026"), "hello-world-2026");
  assert.equal(toSlug("  Multiple   Spaces  "), "multiple-spaces");
});

test("truncate shortens long strings with suffix", () => {
  assert.equal(truncate("Brief text", 20), "Brief text");
  assert.equal(truncate("A very long sentence here", 10), "A very ...");
});

test("camelToKebab converts casing", () => {
  assert.equal(camelToKebab("helloWorld"), "hello-world");
  assert.equal(camelToKebab("userProfileCard"), "user-profile-card");
});

test("capitalizeWords capitalizes each word", () => {
  assert.equal(capitalizeWords("local agent loop"), "Local Agent Loop");
});

test("renderTemplate substitutes variables", () => {
  const result = renderTemplate("Hello {{name}}, order {{id}} is ready", { name: "Alice", id: 42 });
  assert.equal(result, "Hello Alice, order 42 is ready");
});
