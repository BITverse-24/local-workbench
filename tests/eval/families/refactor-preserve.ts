import { Rng } from "../core/prng.js";
import type { FileMap, TaskFamily, TaskInstance } from "../core/task-spec.js";
import { jsPackage, lit, pyLit } from "./util.js";

const PAIRS_JS = [
  { oldName: "calcFee", newName: "computeServiceFee" },
  { oldName: "normTag", newName: "normalizeTagCode" },
  { oldName: "fmtBytes", newName: "formatByteCount" },
  { oldName: "clampVal", newName: "clampSensorValue" },
];
const PAIRS_PY = [
  { oldName: "calc_fee", newName: "compute_service_fee" },
  { oldName: "norm_tag", newName: "normalize_tag_code" },
  { oldName: "fmt_bytes", newName: "format_byte_count" },
  { oldName: "clamp_val", newName: "clamp_sensor_value" },
];

function jsProject(rng: Rng, oldName: string, newName: string) {
  const rate = rng.pick([2, 4, 5]);
  const floor = rng.pick([1, 2, 3]);
  const make = (fn: string): FileMap => ({
    "src/fees.js": `function ${fn}(amount) {\n  const raw = Math.round(amount * ${rate}) / 100;\n  return Math.max(${floor}, raw);\n}\n\nmodule.exports = { ${fn} };\n`,
    "src/cart.js": `const { ${fn} } = require("./fees");\n\nfunction cartBreakdown(items) {\n  const base = items.reduce((s, x) => s + x, 0);\n  const fee = ${fn}(base);\n  return { base, fee, total: Math.round((base + fee) * 100) / 100 };\n}\n\nmodule.exports = { cartBreakdown };\n`,
    "src/invoice.js": `const { ${fn} } = require("./fees");\n\nfunction invoiceLines(amounts) {\n  return amounts.map((a) => ({ amount: a, fee: ${fn}(a) }));\n}\n\nmodule.exports = { invoiceLines };\n`,
    "src/batch.js": `const { ${fn} } = require("./fees");\n\nfunction totalFees(amounts) {\n  return Math.round(amounts.reduce((s, a) => s + ${fn}(a), 0) * 100) / 100;\n}\n\nmodule.exports = { totalFees };\n`,
    "src/summary.js": `const { ${fn} } = require("./fees");\nconst { cartBreakdown } = require("./cart");\nconst { totalFees } = require("./batch");\n\nfunction quoteSummary(carts) {\n  const perCart = carts.map((c) => cartBreakdown(c));\n  const flatFees = totalFees(perCart.map((c) => c.base));\n  const probe = ${fn}(100);\n  return { count: carts.length, flatFees, probe };\n}\n\nmodule.exports = { quoteSummary };\n`,
    "src/audit.js": `const { ${fn} } = require("./fees");\nconst { invoiceLines } = require("./invoice");\n\nfunction auditSchedule(samples) {\n  const lines = invoiceLines(samples);\n  const maxFee = lines.reduce((m, l) => Math.max(m, l.fee), ${fn}(0));\n  return { lines: lines.length, maxFee };\n}\n\nmodule.exports = { auditSchedule };\n`,
  });
  const base: FileMap = {
    "package.json": jsPackage("fees-refactor", "node --test test/*.test.js"),
    "test/summary.test.js": `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { quoteSummary } = require("../src/summary");\nconst { auditSchedule } = require("../src/audit");\n\ntest("computes summary and audit schedule", () => {\n  const s = quoteSummary([[100, 50], [20]]);\n  assert.equal(s.count, 2);\n  assert.equal(typeof s.flatFees, "number");\n  const a = auditSchedule([10, 200, 500]);\n  assert.equal(a.lines, 3);\n});\n`,
  };
  const hidden: FileMap = {
    "test/hidden-refactor.test.js": `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst fees = require("../src/fees");\n\ntest("exports the new symbol and removes the old one", () => {\n  assert.equal(typeof fees[${lit(newName)}], "function");\n  assert.equal(${lit(oldName)} in fees, false);\n});\n\ntest("no source file still mentions the old name", () => {\n  for (const f of ["fees.js", "cart.js", "invoice.js", "batch.js", "summary.js", "audit.js"]) {\n    const text = fs.readFileSync(path.join(__dirname, "../src", f), "utf8");\n    assert.equal(new RegExp(${lit(`\\b${oldName}\\b`)}).test(text), false, \`stale reference in \${f}\`);\n  }\n});\n`,
  };
  return {
    prompt: `Rename \`${oldName}\` in \`src/fees.js\` to \`${newName}\` and update every file in \`src/\` that imports or calls it. Remove the old export name. Keep all public functions in the other modules unchanged, and do not modify tests.`,
    workspace: { ...base, ...make(oldName) },
    reference: make(newName),
    hidden,
    allow: ["src/**"],
    protect: ["test/summary.test.js", "package.json"],
    command: "node --test test/*.test.js",
  };
}

function pyProject(rng: Rng, oldName: string, newName: string) {
  const rate = rng.pick([2, 4, 5]);
  const floor = rng.pick([1, 2, 3]);
  const make = (fn: string): FileMap => ({
    "fees.py": `def ${fn}(amount):\n    raw = round(amount * ${rate} / 100.0, 2)\n    return max(${floor}.0, raw)\n`,
    "cart.py": `from fees import ${fn}\n\n\ndef cart_breakdown(items):\n    base = sum(items)\n    fee = ${fn}(base)\n    return {"base": base, "fee": fee, "total": round(base + fee, 2)}\n`,
    "invoice.py": `from fees import ${fn}\n\n\ndef invoice_lines(amounts):\n    return [{"amount": a, "fee": ${fn}(a)} for a in amounts]\n`,
    "batch.py": `from fees import ${fn}\n\n\ndef total_fees(amounts):\n    return round(sum(${fn}(a) for a in amounts), 2)\n`,
    "summary.py": `from fees import ${fn}\nfrom cart import cart_breakdown\nfrom batch import total_fees\n\n\ndef quote_summary(carts):\n    per_cart = [cart_breakdown(c) for c in carts]\n    flat_fees = total_fees([c["base"] for c in per_cart])\n    return {"count": len(carts), "flat_fees": flat_fees, "probe": ${fn}(100)}\n`,
    "audit.py": `from fees import ${fn}\nfrom invoice import invoice_lines\n\n\ndef audit_schedule(samples):\n    lines = invoice_lines(samples)\n    max_fee = max([l["fee"] for l in lines] + [${fn}(0)])\n    return {"lines": len(lines), "max_fee": max_fee}\n`,
  });
  const base: FileMap = {
    "test_summary.py": `import unittest\nfrom summary import quote_summary\nfrom audit import audit_schedule\n\n\nclass SummaryTests(unittest.TestCase):\n    def test_summary_and_audit(self):\n        s = quote_summary([[100, 50], [20]])\n        self.assertEqual(s["count"], 2)\n        a = audit_schedule([10, 200, 500])\n        self.assertEqual(a["lines"], 3)\n\n\nif __name__ == "__main__":\n    unittest.main()\n`,
  };
  const files = ["fees.py", "cart.py", "invoice.py", "batch.py", "summary.py", "audit.py"];
  const hidden: FileMap = {
    "test_hidden_refactor.py": `import re\nimport pathlib\nimport unittest\nimport fees\n\n\nclass HiddenRefactorTests(unittest.TestCase):\n    def test_new_symbol_and_no_old_symbol(self):\n        self.assertTrue(callable(getattr(fees, ${pyLit(newName)}, None)))\n        self.assertFalse(hasattr(fees, ${pyLit(oldName)}))\n\n    def test_no_stale_references(self):\n        root = pathlib.Path(__file__).parent\n        for name in ${pyLit(files)}:\n            text = (root / name).read_text()\n            self.assertIsNone(re.search(r"\\b" + ${pyLit(oldName)} + r"\\b", text), f"stale reference in {name}")\n`,
  };
  return {
    prompt: `Rename \`${oldName}\` in \`fees.py\` to \`${newName}\` and update every module that imports or calls it. Remove the old name. Keep all other functions unchanged, and do not modify tests.`,
    workspace: { ...base, ...make(oldName) },
    reference: make(newName),
    hidden,
    allow: files,
    protect: ["test_summary.py"],
    command: "python3 -B -m unittest discover -s . -p 'test_*.py'",
  };
}

function generate(seed: number): TaskInstance {
  const rng = new Rng(seed * 6173 + 5);
  const lang = seed % 2 === 0 ? "py" : "js";
  const idx = Math.floor((seed - 1) / 2) % PAIRS_JS.length;
  const pair = (lang === "js" ? PAIRS_JS : PAIRS_PY)[idx];
  const p = lang === "js" ? jsProject(rng, pair.oldName, pair.newName) : pyProject(rng, pair.oldName, pair.newName);
  return {
    id: `refactor-preserve/${seed}`,
    family: "refactor-preserve",
    seed,
    tier: "hard",
    mode: "agent",
    prompt: p.prompt,
    workspace: p.workspace,
    reference: { files: p.reference },
    hidden: p.hidden,
    oracles: [
      { type: "command", command: p.command },
      { type: "scope", allow: p.allow, protect: p.protect, requireChange: true },
    ],
    expectation: "complete",
    limits: { timeoutMs: 600000 },
    promptLiterals: [pair.oldName, pair.newName],
    requires: lang === "py" ? ["python3"] : ["node"],
  };
}

export const refactorPreserve: TaskFamily = {
  id: "refactor-preserve",
  tier: "hard",
  mode: "agent",
  description: "Rename an exported symbol across 6 modules (5 call sites) with no stale references left behind.",
  devSeeds: Array.from({ length: 8 }, (_, i) => i + 1),
  generate,
};
