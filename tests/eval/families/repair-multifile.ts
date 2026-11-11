import { Rng } from "../core/prng.js";
import type { FileMap, TaskFamily, TaskInstance } from "../core/task-spec.js";
import { lit, money, mutate, overlay, pyLit, round2 } from "./util.js";

type Lang = "js" | "py";
interface Bug {
  id: string;
  file: string;
  from: string;
  to: string;
  /** Mirror of the bug for TypeScript-side checks. */
  flags: Partial<Record<"floorRound" | "rateScale" | "taxIgnoresDiscount" | "ignoreQty" | "strictCutoff" | "countWeights" | "ascending" | "floorAvg", boolean>>;
}

/* ───────────── billing ───────────── */

interface Line {
  price: number;
  qty: number;
}
interface Case {
  items: Line[];
  discountPct: number;
  taxPct: number;
}

function billingMirror(c: Case, flags: Bug["flags"]) {
  const round = (v: number) => (flags.floorRound ? Math.floor(v * 100) / 100 : Math.round(v * 100) / 100);
  const rate = (amount: number, pct: number) => round((amount * pct) / (flags.rateScale ? 10 : 100));
  const lineTotal = (i: Line) => round(flags.ignoreQty ? i.price : i.price * i.qty);
  const subtotal = round(c.items.reduce((s, i) => s + lineTotal(i), 0));
  const discount = rate(subtotal, c.discountPct);
  const taxable = flags.taxIgnoresDiscount ? subtotal : round(subtotal - discount);
  const tax = rate(taxable, c.taxPct);
  return { subtotal, discount, tax, total: round(taxable + tax) };
}
const formatBilling = (t: ReturnType<typeof billingMirror>) => `Subtotal ${money(t.subtotal)} | Discount ${money(t.discount)} | Tax ${money(t.tax)} | Total ${money(t.total)}`;

const BILLING_BUGS: Bug[] = [
  { id: "floor-round", file: "money", from: "Math.round(value * 100) / 100", to: "Math.floor(value * 100) / 100", flags: { floorRound: true } },
  { id: "rate-scale", file: "money", from: "(amount * ratePct) / 100", to: "(amount * ratePct) / 10", flags: { rateScale: true } },
  { id: "tax-ignores-discount", file: "invoice", from: "const taxable = roundMoney(subtotal - discount);", to: "const taxable = subtotal;", flags: { taxIgnoresDiscount: true } },
  { id: "ignore-qty", file: "invoice", from: "return roundMoney(item.price * item.qty);", to: "return roundMoney(item.price);", flags: { ignoreQty: true } },
];
const PY_BILLING: Record<string, { from: string; to: string }> = {
  "floor-round": { from: "math.floor(value * 100 + 0.5) / 100", to: "math.floor(value * 100) / 100" },
  "rate-scale": { from: "(amount * rate_pct) / 100", to: "(amount * rate_pct) / 10" },
  "tax-ignores-discount": { from: "taxable = round_money(subtotal - discount)", to: "taxable = subtotal" },
  "ignore-qty": { from: "return round_money(item[\"price\"] * item[\"qty\"])", to: "return round_money(item[\"price\"])" },
};

function billingFiles(lang: Lang, rng: Rng): { clean: FileMap; cases: Case[]; test: FileMap; command: string; srcDir: string } {
  const cases: Case[] = Array.from({ length: 3 }, () => ({
    items: Array.from({ length: rng.int(2, 4) }, () => ({ price: rng.float(1.1, 49.99, 2), qty: rng.int(2, 9) })),
    discountPct: rng.pick([5, 10, 15]),
    taxPct: rng.pick([7, 8, 12, 18]),
  }));
  if (lang === "js") {
    const clean: FileMap = {
      "package.json": `{\n  "name": "billing",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node --test test/*.test.js" }\n}\n`,
      "src/money.js": `function roundMoney(value) {\n  return Math.round(value * 100) / 100;\n}\n\nfunction applyRate(amount, ratePct) {\n  return roundMoney((amount * ratePct) / 100);\n}\n\nmodule.exports = { roundMoney, applyRate };\n`,
      "src/invoice.js": `const { roundMoney, applyRate } = require("./money");\n\nfunction lineTotal(item) {\n  return roundMoney(item.price * item.qty);\n}\n\nfunction invoiceTotal(items, options = {}) {\n  const subtotal = roundMoney(items.reduce((sum, item) => sum + lineTotal(item), 0));\n  const discount = applyRate(subtotal, options.discountPct || 0);\n  const taxable = roundMoney(subtotal - discount);\n  const tax = applyRate(taxable, options.taxPct || 0);\n  return { subtotal, discount, tax, total: roundMoney(taxable + tax) };\n}\n\nmodule.exports = { lineTotal, invoiceTotal };\n`,
      "src/report.js": `const { invoiceTotal } = require("./invoice");\n\nfunction formatInvoice(items, options) {\n  const t = invoiceTotal(items, options);\n  return \`Subtotal \${t.subtotal.toFixed(2)} | Discount \${t.discount.toFixed(2)} | Tax \${t.tax.toFixed(2)} | Total \${t.total.toFixed(2)}\`;\n}\n\nmodule.exports = { formatInvoice };\n`,
    };
    const body = cases.map((c, i) => `test("formats invoice ${i + 1}", () => {\n  assert.equal(formatInvoice(${lit(c.items)}, { discountPct: ${c.discountPct}, taxPct: ${c.taxPct} }), ${lit(formatBilling(billingMirror(c, {})))});\n});\n`).join("\n");
    return { clean, cases, srcDir: "src", command: "node --test test/*.test.js", test: { "test/report.test.js": `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { formatInvoice } = require("../src/report");\n\n${body}` } };
  }
  const clean: FileMap = {
    "money.py": `import math\n\n\ndef round_money(value):\n    return math.floor(value * 100 + 0.5) / 100\n\n\ndef apply_rate(amount, rate_pct):\n    return round_money((amount * rate_pct) / 100)\n`,
    "invoice.py": `from money import round_money, apply_rate\n\n\ndef line_total(item):\n    return round_money(item["price"] * item["qty"])\n\n\ndef invoice_total(items, discount_pct=0, tax_pct=0):\n    subtotal = round_money(sum(line_total(i) for i in items))\n    discount = apply_rate(subtotal, discount_pct)\n    taxable = round_money(subtotal - discount)\n    tax = apply_rate(taxable, tax_pct)\n    return {"subtotal": subtotal, "discount": discount, "tax": tax, "total": round_money(taxable + tax)}\n`,
    "report.py": `from invoice import invoice_total\n\n\ndef format_invoice(items, discount_pct=0, tax_pct=0):\n    t = invoice_total(items, discount_pct, tax_pct)\n    return f"Subtotal {t['subtotal']:.2f} | Discount {t['discount']:.2f} | Tax {t['tax']:.2f} | Total {t['total']:.2f}"\n`,
  };
  const body = cases.map((c, i) => `    def test_invoice_${i + 1}(self):\n        self.assertEqual(format_invoice(${pyLit(c.items)}, ${c.discountPct}, ${c.taxPct}), ${pyLit(formatBilling(billingMirror(c, {})))})\n`).join("\n");
  return { clean, cases, srcDir: ".", command: "python3 -B -m unittest test_report.py", test: { "test_report.py": `import unittest\n\nfrom report import format_invoice\n\n\nclass ReportTests(unittest.TestCase):\n${body}\n\nif __name__ == "__main__":\n    unittest.main()\n` } };
}

/* ───────────── gradebook ───────────── */

interface Student {
  name: string;
  scores: { homework: number; quiz: number; exam: number };
}
const CUTOFFS: Array<[string, number]> = [["A", 90], ["B", 80], ["C", 70], ["D", 60]];

function gradeMirror(students: Student[], weights: Record<string, number>, flags: Bug["flags"]) {
  const cats = ["homework", "quiz", "exam"] as const;
  const avg = (s: Student) => {
    let total = 0;
    let wsum = 0;
    for (const c of cats) {
      total += s.scores[c] * weights[c];
      wsum += flags.countWeights ? 1 : weights[c];
    }
    const mean = wsum === 0 ? 0 : total / wsum;
    return flags.floorAvg ? Math.floor(mean * 10) / 10 : Math.round(mean * 10) / 10;
  };
  const letter = (score: number) => {
    for (const [l, min] of CUTOFFS) if (flags.strictCutoff ? score > min : score >= min) return l;
    return "F";
  };
  const rows = students.map((s) => ({ name: s.name, average: avg(s), letter: letter(avg(s)) }));
  rows.sort((a, b) => (flags.ascending ? a.average - b.average : b.average - a.average) || a.name.localeCompare(b.name));
  return rows.map((r, i) => `${i + 1}. ${r.name} ${r.average.toFixed(1)} ${r.letter}`).join("\n");
}

const GRADE_BUGS: Bug[] = [
  { id: "strict-cutoff", file: "stats", from: "score >= min", to: "score > min", flags: { strictCutoff: true } },
  { id: "weight-count", file: "stats", from: "weightSum += weights[i];", to: "weightSum += 1;", flags: { countWeights: true } },
  { id: "sort-ascending", file: "gradebook", from: "b.average - a.average", to: "a.average - b.average", flags: { ascending: true } },
  { id: "floor-average", file: "gradebook", from: "Math.round(weightedMean(values, weights) * 10) / 10", to: "Math.floor(weightedMean(values, weights) * 10) / 10", flags: { floorAvg: true } },
];
const PY_GRADE: Record<string, { from: string; to: string }> = {
  "strict-cutoff": { from: "if score >= minimum:", to: "if score > minimum:" },
  "weight-count": { from: "weight_sum += weights[i]", to: "weight_sum += 1" },
  "sort-ascending": { from: "key=lambda r: (-r[\"average\"], r[\"name\"])", to: "key=lambda r: (r[\"average\"], r[\"name\"])" },
  "floor-average": { from: "round(weighted_mean(values, weights) * 10 + 1e-9) / 10", to: "math.floor(weighted_mean(values, weights) * 10) / 10" },
};

function gradebookFiles(lang: Lang, rng: Rng): { clean: FileMap; students: Student[]; weights: Record<string, number>; test: FileMap; command: string; srcDir: string } {
  const w1 = rng.pick([0.2, 0.25, 0.3]);
  const w2 = rng.pick([0.2, 0.25, 0.3]);
  const weights = { homework: w1, quiz: w2, exam: Math.round((1 - w1 - w2) * 100) / 100 };
  const cutoffScore = rng.pick([90, 80, 70]);
  const names = rng.sample(["Asha", "Bruno", "Chen", "Dara", "Elif", "Farid", "Gita", "Hugo"], 4);
  const students: Student[] = names.map((name) => ({ name, scores: { homework: rng.int(55, 99), quiz: rng.int(55, 99), exam: rng.int(55, 99) } }));
  // One student sits exactly on a grade cutoff so boundary bugs are observable.
  students[0] = { name: names[0], scores: { homework: cutoffScore, quiz: cutoffScore, exam: cutoffScore } };
  const expected = gradeMirror(students, weights, {});
  if (lang === "js") {
    const clean: FileMap = {
      "package.json": `{\n  "name": "gradebook",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node --test test/*.test.js" }\n}\n`,
      "src/stats.js": `function weightedMean(values, weights) {\n  let total = 0;\n  let weightSum = 0;\n  for (let i = 0; i < values.length; i++) {\n    total += values[i] * weights[i];\n    weightSum += weights[i];\n  }\n  return weightSum === 0 ? 0 : total / weightSum;\n}\n\nfunction letterGrade(score, cutoffs) {\n  for (const [letter, min] of cutoffs) {\n    if (score >= min) return letter;\n  }\n  return "F";\n}\n\nmodule.exports = { weightedMean, letterGrade };\n`,
      "src/gradebook.js": `const { weightedMean, letterGrade } = require("./stats");\n\nconst WEIGHTS = ${lit(weights)};\nconst CUTOFFS = ${lit(CUTOFFS)};\n\nfunction studentAverage(student) {\n  const categories = Object.keys(WEIGHTS);\n  const values = categories.map((c) => student.scores[c]);\n  const weights = categories.map((c) => WEIGHTS[c]);\n  return Math.round(weightedMean(values, weights) * 10) / 10;\n}\n\nfunction classReport(students) {\n  return students\n    .map((s) => {\n      const average = studentAverage(s);\n      return { name: s.name, average, letter: letterGrade(average, CUTOFFS) };\n    })\n    .sort((a, b) => b.average - a.average || a.name.localeCompare(b.name));\n}\n\nmodule.exports = { studentAverage, classReport };\n`,
      "src/report.js": `const { classReport } = require("./gradebook");\n\nfunction renderReport(students) {\n  return classReport(students)\n    .map((r, i) => \`\${i + 1}. \${r.name} \${r.average.toFixed(1)} \${r.letter}\`)\n    .join("\\n");\n}\n\nmodule.exports = { renderReport };\n`,
    };
    return { clean, students, weights, srcDir: "src", command: "node --test test/*.test.js", test: { "test/report.test.js": `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { renderReport } = require("../src/report");\n\ntest("renders the ranked class report", () => {\n  assert.equal(renderReport(${lit(students)}), ${lit(expected)});\n});\n` } };
  }
  const clean: FileMap = {
    "stats.py": `def weighted_mean(values, weights):\n    total = 0\n    weight_sum = 0\n    for i in range(len(values)):\n        total += values[i] * weights[i]\n        weight_sum += weights[i]\n    return 0 if weight_sum == 0 else total / weight_sum\n\n\ndef letter_grade(score, cutoffs):\n    for letter, minimum in cutoffs:\n        if score >= minimum:\n            return letter\n    return "F"\n`,
    "gradebook.py": `import math\n\nfrom stats import weighted_mean, letter_grade\n\nWEIGHTS = ${pyLit(weights)}\nCUTOFFS = ${pyLit(CUTOFFS)}\n\n\ndef student_average(student):\n    categories = list(WEIGHTS)\n    values = [student["scores"][c] for c in categories]\n    weights = [WEIGHTS[c] for c in categories]\n    return round(weighted_mean(values, weights) * 10 + 1e-9) / 10\n\n\ndef class_report(students):\n    rows = []\n    for s in students:\n        average = student_average(s)\n        rows.append({"name": s["name"], "average": average, "letter": letter_grade(average, CUTOFFS)})\n    rows.sort(key=lambda r: (-r["average"], r["name"]))\n    return rows\n`,
    "report.py": `from gradebook import class_report\n\n\ndef render_report(students):\n    rows = class_report(students)\n    return "\\n".join(f"{i + 1}. {r['name']} {r['average']:.1f} {r['letter']}" for i, r in enumerate(rows))\n`,
  };
  return { clean, students, weights, srcDir: ".", command: "python3 -B -m unittest test_report.py", test: { "test_report.py": `import unittest\n\nfrom report import render_report\n\n\nclass ReportTests(unittest.TestCase):\n    def test_ranked_class_report(self):\n        self.assertEqual(render_report(${pyLit(students)}), ${pyLit(expected)})\n\n\nif __name__ == "__main__":\n    unittest.main()\n` } };
}

/* ───────────── family ───────────── */

function generate(seed: number): TaskInstance {
  const rng = new Rng(seed * 7919 + 13);
  const lang: Lang = seed % 2 === 0 ? "py" : "js";
  const domain = Math.floor((seed - 1) / 2) % 2 === 0 ? "billing" : "gradebook";
  const ext = lang === "js" ? "js" : "py";
  const pool = domain === "billing" ? BILLING_BUGS : GRADE_BUGS;
  let bug = pool[Math.floor(seed / 4) % pool.length];
  let built = domain === "billing" ? billingFiles(lang, rng) : gradebookFiles(lang, rng);
  // Re-roll data until the bug is observable through the test (it must change the expected output).
  for (let attempt = 0; attempt < 25; attempt++) {
    const observable =
      "cases" in built
        ? built.cases.some((c) => formatBilling(billingMirror(c, {})) !== formatBilling(billingMirror(c, bug.flags)))
        : gradeMirror((built as { students: Student[] }).students, (built as { weights: Record<string, number> }).weights, {}) !== gradeMirror((built as { students: Student[] }).students, (built as { weights: Record<string, number> }).weights, bug.flags);
    if (observable) break;
    built = domain === "billing" ? billingFiles(lang, rng) : gradebookFiles(lang, rng);
  }
  const fileKey = (b: Bug) => (lang === "js" ? `src/${b.file}.js` : `${b.file === "money" ? "money" : b.file}.py`);
  const target = fileKey(bug);
  const edit = lang === "js" ? { from: bug.from, to: bug.to } : (domain === "billing" ? PY_BILLING : PY_GRADE)[bug.id];
  const cleanFile = built.clean[target];
  if (typeof cleanFile !== "string") throw new Error(`missing ${target}`);
  const workspace = overlay({ ...built.clean, ...built.test }, { [target]: mutate(cleanFile, edit.from, edit.to) });
  const symptom =
    domain === "billing"
      ? "The invoice report prints wrong amounts for some orders. Find the root cause and fix it so the tests pass."
      : "The class report ranks students or assigns letter grades incorrectly. Find the root cause and fix it so the tests pass.";
  const protect = Object.keys(built.test);
  void ext;
  return {
    id: `repair-multifile/${seed}`,
    family: "repair-multifile",
    seed,
    tier: "core",
    mode: "agent",
    prompt: `${symptom} Do not change the tests.`,
    workspace,
    reference: { files: { [target]: cleanFile } },
    oracles: [
      { type: "command", command: built.command },
      { type: "scope", allow: [target], protect, requireChange: true },
    ],
    expectation: "complete",
    limits: { timeoutMs: 600000 },
    requires: lang === "py" ? ["python3"] : ["node"],
  };
}

export const repairMultifile: TaskFamily = {
  id: "repair-multifile",
  tier: "core",
  mode: "agent",
  description: "Three-file project; the bug is in a helper or middle layer, the failing test is on the top-level report, and the prompt gives only the symptom.",
  devSeeds: Array.from({ length: 16 }, (_, i) => i + 1),
  generate,
};

export { round2 };
