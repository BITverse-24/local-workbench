import { Rng } from "../core/prng.js";
import type { FileMap, TaskFamily, TaskInstance } from "../core/task-spec.js";
import { jsPackage, lit, pyLit } from "./util.js";

type Lang = "js" | "py";

interface Scenario {
  prompt: string;
  workspace: FileMap;
  reference: FileMap;
  hidden: FileMap;
  allow: string[];
  protect: string[];
  command: string;
}

function couponJs(rng: Rng): Scenario {
  const capPct = rng.pick([35, 40, 50]);
  const minTotal = rng.pick([50, 75, 100]);
  const code = `SAVE${rng.int(10, 30)}`;
  const pct = rng.pick([15, 20, 25]);
  return {
    prompt: [
      `Add \`applyCoupon(order, coupons)\` in \`src/pricing.js\` and call it from \`checkoutTotal(order, coupons)\` in \`src/checkout.js\`.`,
      `Rules:`,
      `- Each entry in \`coupons\` is \`{ code, pct, minSubtotal, active }\`.`,
      `- Match \`order.coupon\` case-insensitively after trimming whitespace.`,
      `- Ignore missing, unknown, or inactive coupons, and coupons whose \`minSubtotal\` exceeds the order subtotal.`,
      `- Cap any coupon percentage at ${capPct}% maximum.`,
      `- Round the discount and final total to 2 decimal places with \`roundCents\`. Never return a negative total.`,
      `- Export \`applyCoupon\` from \`src/pricing.js\`. Keep existing exports working. Do not change tests.`,
    ].join("\n"),
    workspace: {
      "package.json": jsPackage("shop", "node --test test/*.test.js"),
      "src/pricing.js": `function roundCents(v) {\n  return Math.round(v * 100) / 100;\n}\n\nfunction subtotal(items) {\n  return roundCents(items.reduce((s, i) => s + i.price * i.qty, 0));\n}\n\nmodule.exports = { roundCents, subtotal };\n`,
      "src/checkout.js": `const { roundCents, subtotal } = require("./pricing");\n\nfunction checkoutTotal(order) {\n  return roundCents(subtotal(order.items));\n}\n\nmodule.exports = { checkoutTotal };\n`,
      "test/checkout.test.js": `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { checkoutTotal } = require("../src/checkout");\n\nconst COUPONS = [{ code: ${lit(code)}, pct: ${pct}, minSubtotal: ${minTotal}, active: true }];\n\ntest("applies a matching coupon", () => {\n  const order = { items: [{ price: ${minTotal}, qty: 2 }], coupon: ${lit(code)} };\n  assert.equal(checkoutTotal(order, COUPONS), ${Math.round(minTotal * 2 * (1 - pct / 100) * 100) / 100});\n});\n`,
    },
    reference: {
      "src/pricing.js": `function roundCents(v) {\n  return Math.round(v * 100) / 100;\n}\n\nfunction subtotal(items) {\n  return roundCents(items.reduce((s, i) => s + i.price * i.qty, 0));\n}\n\nfunction applyCoupon(order, coupons = []) {\n  const sub = subtotal(order.items || []);\n  const raw = typeof order.coupon === "string" ? order.coupon.trim().toLowerCase() : "";\n  if (!raw) return 0;\n  const match = (coupons || []).find((c) => c && c.active && String(c.code || "").trim().toLowerCase() === raw);\n  if (!match || sub < (match.minSubtotal || 0)) return 0;\n  const bounded = Math.min(Math.max(Number(match.pct) || 0, 0), ${capPct});\n  return Math.min(sub, roundCents((sub * bounded) / 100));\n}\n\nmodule.exports = { roundCents, subtotal, applyCoupon };\n`,
      "src/checkout.js": `const { roundCents, subtotal, applyCoupon } = require("./pricing");\n\nfunction checkoutTotal(order, coupons = []) {\n  const sub = subtotal(order.items);\n  const discount = applyCoupon(order, coupons);\n  return Math.max(0, roundCents(sub - discount));\n}\n\nmodule.exports = { checkoutTotal };\n`,
    },
    hidden: {
      "test/hidden-edge.test.js": `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { checkoutTotal } = require("../src/checkout");\nconst { applyCoupon } = require("../src/pricing");\n\nconst COUPONS = [\n  { code: ${lit(code)}, pct: ${pct}, minSubtotal: ${minTotal}, active: true },\n  { code: "DEAD", pct: 30, minSubtotal: 0, active: false },\n  { code: "HUGE", pct: 90, minSubtotal: 10, active: true },\n];\n\ntest("matches case-insensitively and trims whitespace", () => {\n  assert.equal(applyCoupon({ items: [{ price: ${minTotal}, qty: 1 }], coupon: ${lit(`  ${code.toLowerCase()} `)} }, COUPONS), ${Math.round(minTotal * (pct / 100) * 100) / 100});\n});\n\ntest("rejects inactive, unknown, and below-minimum coupons", () => {\n  assert.equal(checkoutTotal({ items: [{ price: 20, qty: 1 }], coupon: "DEAD" }, COUPONS), 20);\n  assert.equal(checkoutTotal({ items: [{ price: 20, qty: 1 }], coupon: "NOPE" }, COUPONS), 20);\n  assert.equal(checkoutTotal({ items: [{ price: ${minTotal - 10}, qty: 1 }], coupon: ${lit(code)} }, COUPONS), ${minTotal - 10});\n});\n\ntest("caps discount at ${capPct}%", () => {\n  assert.equal(checkoutTotal({ items: [{ price: 100, qty: 1 }], coupon: "HUGE" }, COUPONS), ${100 - capPct});\n});\n`,
    },
    allow: ["src/pricing.js", "src/checkout.js"],
    protect: ["test/checkout.test.js", "package.json"],
    command: "node --test test/*.test.js",
  };
}

function couponPy(rng: Rng): Scenario {
  const capPct = rng.pick([35, 40, 50]);
  const minTotal = rng.pick([60, 80, 120]);
  const code = `PROMO${rng.int(10, 40)}`;
  const pct = rng.pick([10, 20, 25]);
  return {
    prompt: [
      `Add \`apply_coupon(order, coupons=None)\` in \`pricing.py\` and call it from \`checkout_total(order, coupons=None)\` in \`checkout.py\`.`,
      `Rules:`,
      `- Each entry in \`coupons\` is \`{"code", "pct", "min_subtotal", "active"}\`.`,
      `- Match \`order.get("coupon")\` case-insensitively after stripping whitespace.`,
      `- Ignore missing, unknown, or inactive coupons, and coupons whose \`min_subtotal\` exceeds the order subtotal.`,
      `- Cap any coupon percentage at ${capPct}% maximum.`,
      `- Round the discount and final total to 2 decimal places with \`round_cents\`. Never return a negative total. Do not change tests.`,
    ].join("\n"),
    workspace: {
      "pricing.py": `import math\n\n\ndef round_cents(v):\n    return math.floor(v * 100 + 0.5) / 100\n\n\ndef subtotal(items):\n    return round_cents(sum(i["price"] * i["qty"] for i in items))\n`,
      "checkout.py": `from pricing import round_cents, subtotal\n\n\ndef checkout_total(order, coupons=None):\n    return round_cents(subtotal(order["items"]))\n`,
      "test_checkout.py": `import unittest\nfrom checkout import checkout_total\n\nCOUPONS = [{"code": ${pyLit(code)}, "pct": ${pct}, "min_subtotal": ${minTotal}, "active": True}]\n\n\nclass CheckoutTests(unittest.TestCase):\n    def test_matching_coupon(self):\n        order = {"items": [{"price": ${minTotal}, "qty": 2}], "coupon": ${pyLit(code)}}\n        self.assertEqual(checkout_total(order, COUPONS), ${Math.round(minTotal * 2 * (1 - pct / 100) * 100) / 100})\n\n\nif __name__ == "__main__":\n    unittest.main()\n`,
    },
    reference: {
      "pricing.py": `import math\n\n\ndef round_cents(v):\n    return math.floor(v * 100 + 0.5) / 100\n\n\ndef subtotal(items):\n    return round_cents(sum(i["price"] * i["qty"] for i in items))\n\n\ndef apply_coupon(order, coupons=None):\n    sub = subtotal(order.get("items", []))\n    raw = order.get("coupon")\n    key = raw.strip().lower() if isinstance(raw, str) else ""\n    if not key:\n        return 0\n    match = next((c for c in (coupons or []) if c.get("active") and str(c.get("code", "")).strip().lower() == key), None)\n    if not match or sub < match.get("min_subtotal", 0):\n        return 0\n    bounded = min(max(float(match.get("pct", 0)), 0.0), ${capPct}.0)\n    return min(sub, round_cents(sub * bounded / 100.0))\n`,
      "checkout.py": `from pricing import round_cents, subtotal, apply_coupon\n\n\ndef checkout_total(order, coupons=None):\n    sub = subtotal(order["items"])\n    discount = apply_coupon(order, coupons)\n    return max(0.0, round_cents(sub - discount))\n`,
    },
    hidden: {
      "test_hidden_edge.py": `import unittest\nfrom checkout import checkout_total\nfrom pricing import apply_coupon\n\nCOUPONS = [\n    {"code": ${pyLit(code)}, "pct": ${pct}, "min_subtotal": ${minTotal}, "active": True},\n    {"code": "DEAD", "pct": 30, "min_subtotal": 0, "active": False},\n    {"code": "HUGE", "pct": 90, "min_subtotal": 10, "active": True},\n]\n\n\nclass HiddenCouponTests(unittest.TestCase):\n    def test_case_and_whitespace(self):\n        self.assertEqual(apply_coupon({"items": [{"price": ${minTotal}, "qty": 1}], "coupon": ${pyLit(`  ${code.toLowerCase()} `)}}, COUPONS), ${Math.round(minTotal * (pct / 100) * 100) / 100})\n\n    def test_inactive_unknown_and_minimum(self):\n        self.assertEqual(checkout_total({"items": [{"price": 20, "qty": 1}], "coupon": "DEAD"}, COUPONS), 20)\n        self.assertEqual(checkout_total({"items": [{"price": 20, "qty": 1}], "coupon": "NOPE"}, COUPONS), 20)\n        self.assertEqual(checkout_total({"items": [{"price": ${minTotal - 10}, "qty": 1}], "coupon": ${pyLit(code)}}, COUPONS), ${minTotal - 10})\n\n    def test_cap(self):\n        self.assertEqual(checkout_total({"items": [{"price": 100, "qty": 1}], "coupon": "HUGE"}, COUPONS), ${100 - capPct})\n`,
    },
    allow: ["pricing.py", "checkout.py"],
    protect: ["test_checkout.py"],
    command: "python3 -B -m unittest discover -s . -p 'test_*.py'",
  };
}

function generate(seed: number): TaskInstance {
  const rng = new Rng(seed * 4099 + 29);
  const lang: Lang = seed % 2 === 0 ? "py" : "js";
  const s = lang === "js" ? couponJs(rng) : couponPy(rng);
  return {
    id: `feature-hidden-tests/${seed}`,
    family: "feature-hidden-tests",
    seed,
    tier: "core",
    mode: "agent",
    prompt: s.prompt,
    workspace: s.workspace,
    reference: { files: s.reference },
    hidden: s.hidden,
    oracles: [
      { type: "command", command: s.command },
      { type: "scope", allow: s.allow, protect: s.protect, requireChange: true },
    ],
    expectation: "complete",
    limits: { timeoutMs: 600000 },
    requires: lang === "py" ? ["python3"] : ["node"],
  };
}

export const featureHiddenTests: TaskFamily = {
  id: "feature-hidden-tests",
  tier: "core",
  mode: "agent",
  description: "Add a feature across two modules; visible tests cover only the happy path while hidden oracle tests check the edge cases in the prompt.",
  devSeeds: Array.from({ length: 8 }, (_, i) => i + 1),
  generate,
};
