import JSZip from "jszip";
import { Rng } from "../core/prng.js";
import type { Fact, TaskFamily, TaskInstance } from "../core/task-spec.js";

async function docxFromLines(lines: string[]): Promise<Uint8Array> {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = lines.map((l) => `<w:p><w:r><w:t>${esc(l)}</w:t></w:r></w:p>`).join("");
  const zip = new JSZip();
  const date = new Date("2026-01-01T00:00:00Z");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, { date });
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`, { date });
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`, { date });
  return new Uint8Array(await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
}

/* ───────────── 1. ledger-variance (CSV deliverable) ───────────── */

const DEPTS = ["Maintenance", "Operations", "Quality", "Logistics", "Utilities"];

function genLedger(seed: number): TaskInstance {
  const rng = new Rng(seed * 2791 + 7);
  const depts = rng.sample(DEPTS, 4);
  const budgets: Record<string, number> = {};
  const cleared: Record<string, number> = {};
  const rows: string[] = ["tx_id,department,status,amount"];
  let tx = 1000;
  // Choose one department to overrun and three to stay within budget.
  const overrunDept = depts[0];
  for (const d of depts) {
    const budget = rng.int(40, 90) * 1000;
    budgets[d] = budget;
    const targetPct = d === overrunDept ? rng.int(112, 130) : rng.int(75, 96);
    const total = Math.round((budget * targetPct) / 100);
    cleared[d] = total;
    const partA = Math.round(total * 0.45);
    const partB = total - partA;
    rows.push(`TX-${tx++},${d},CLEARED,${partA}`);
    rows.push(`TX-${tx++},${d},CLEARED,${partB}`);
    // Decoy rows that must be ignored.
    rows.push(`TX-${tx++},${d},PENDING,${rng.int(4, 15) * 1000}`);
    rows.push(`TX-${tx++},${d},DISPUTED,${rng.int(3, 12) * 1000}`);
  }
  const summaryRows = depts.map((d) => {
    const actual = cleared[d];
    const budget = budgets[d];
    const variancePct = (((actual - budget) / budget) * 100).toFixed(2);
    const status = actual > budget ? "OVER_BUDGET" : "WITHIN_BUDGET";
    return { d, budget, actual, variancePct: Number(variancePct), status, line: `${d},${budget},${actual},${variancePct},${status}` };
  });
  const totalCleared = Object.values(cleared).reduce((s, v) => s + v, 0);
  const csvOut = ["department,budget,actual_spend,variance_pct,status", ...summaryRows.map((r) => r.line)].join("\n") + "\n";
  const facts: Fact[] = [
    { kind: "rowCount", count: depts.length },
    ...summaryRows.map(
      (r): Fact => ({
        kind: "row",
        where: { department: r.d },
        expect: {
          budget: { approx: r.budget, tol: 1 },
          actual_spend: { approx: r.actual, tol: 1 },
          variance_pct: { approx: r.variancePct, tol: 0.1 },
          status: r.status,
        },
      }),
    ),
  ];
  return {
    id: `ledger-variance/${seed}`,
    family: "ledger-variance",
    seed,
    tier: "core",
    mode: "work",
    prompt: [
      `Audit the attached \`general-ledger.csv\` against \`budget-targets.json\`.`,
      `- Include only \`CLEARED\` transactions (ignore \`PENDING\` and \`DISPUTED\`).`,
      `- Produce a CSV deliverable named \`variance-summary.csv\` with exact columns \`department,budget,actual_spend,variance_pct,status\`.`,
      `- \`variance_pct\` is \`((actual_spend - budget) / budget) * 100\` rounded to 2 decimal places.`,
      `- \`status\` is \`OVER_BUDGET\` when \`actual_spend > budget\`, otherwise \`WITHIN_BUDGET\`.`,
      `- In your reply, state total cleared spend across all departments and name the over-budget department.`,
    ].join("\n"),
    attachments: {
      "general-ledger.csv": `${rows.join("\n")}\n`,
      "budget-targets.json": `${JSON.stringify({ currency: "USD", budgets }, null, 2)}\n`,
    },
    reference: {
      artifacts: { "variance-summary.csv": csvOut },
      assistantText: `Total cleared spend is ${totalCleared}. Over-budget department: ${overrunDept}.`,
    },
    oracles: [
      { type: "deliverable", filename: "variance-summary\\.csv$", facts },
      { type: "claims", mustFlag: [String(totalCleared), overrunDept] },
    ],
    expectation: "complete",
    limits: { timeoutMs: 600000 },
    promptLiterals: ["OVER_BUDGET", "WITHIN_BUDGET"],
  };
}

/* ───────────── 2. telemetry-anomaly (CSV deliverable) ───────────── */

function genTelemetry(seed: number): TaskInstance {
  const rng = new Rng(seed * 3391 + 11);
  const limit = rng.pick([88, 92, 95]);
  const stations = ["ST-A", "ST-B", "ST-C"];
  const lines = ["timestamp,station,temp_c"];
  const anomalies: Array<{ ts: string; station: string; temp: number }> = [];
  let minute = 0;
  for (let i = 0; i < 36; i++) {
    const st = stations[i % stations.length];
    const ts = `2026-09-01T10:${String(minute).padStart(2, "0")}:00Z`;
    minute = (minute + 1) % 60;
    const temp = rng.float(62, limit - 4, 1);
    lines.push(`${ts},${st},${temp.toFixed(1)}`);
  }
  const anomalyCount = rng.int(3, 5);
  for (let j = 0; j < anomalyCount; j++) {
    const st = stations[j % stations.length];
    const ts = `2026-09-01T11:0${j}:00Z`;
    const temp = rng.float(limit + 1.2, limit + 12, 1);
    anomalies.push({ ts, station: st, temp });
    lines.push(`${ts},${st},${temp.toFixed(1)}`);
  }
  const out = ["timestamp,station,temp_c", ...anomalies.map((a) => `${a.ts},${a.station},${a.temp.toFixed(1)}`)].join("\n") + "\n";
  const facts: Fact[] = [
    { kind: "rowCount", count: anomalies.length },
    ...anomalies.map((a): Fact => ({ kind: "row", where: { timestamp: a.ts, station: a.station }, expect: { temp_c: { approx: a.temp, tol: 0.05 } } })),
  ];
  return {
    id: `telemetry-anomaly/${seed}`,
    family: "telemetry-anomaly",
    seed,
    tier: "core",
    mode: "work",
    prompt: [
      `Inspect \`sensor-telemetry.csv\` and extract every reading where \`temp_c > ${limit}\`.`,
      `Write the matching rows to a CSV deliverable named \`anomaly-register.csv\` with columns \`timestamp,station,temp_c\` in chronological order.`,
      `Report the exact anomaly count in your reply.`,
    ].join("\n"),
    attachments: { "sensor-telemetry.csv": `${lines.join("\n")}\n` },
    reference: { artifacts: { "anomaly-register.csv": out }, assistantText: `Found ${anomalies.length} anomalies above ${limit} C.` },
    oracles: [{ type: "deliverable", filename: "anomaly-register\\.csv$", facts }],
    expectation: "complete",
    limits: { timeoutMs: 600000 },
  };
}

/* ───────────── 3. sop-check-note (DOCX deliverable + KB grounding) ───────────── */

async function genSopNote(seed: number): Promise<TaskInstance> {
  const rng = new Rng(seed * 4999 + 3);
  const unit = `HX-${rng.int(201, 299)}`;
  const clause = `SOP-${rng.int(110, 190)} §${rng.int(2, 6)}.${rng.int(1, 4)}`;
  const minWall = rng.float(3.0, 4.5, 1);
  const measured = Math.round((minWall - rng.float(0.4, 0.9, 1)) * 10) / 10;
  const weld = `WELD-${rng.int(2, 9)}B`;
  const sop = [
    `# Pressure Equipment Standard (${clause.split(" ")[0]})`,
    `## ${clause}`,
    `- Minimum allowable wall thickness for heat exchangers is **${minWall.toFixed(1)} mm**.`,
    `- Any reading below ${minWall.toFixed(1)} mm or any unverified weld note requires **HOLD_FOR_REPAIR**; full sign-off is prohibited.`,
  ].join("\n");
  const report = [
    `# Ultrasonic Inspection Report — Unit ${unit}`,
    `- Measured minimum wall thickness: ${measured.toFixed(1)} mm (Shell Zone B)`,
    `- Inspector margin note: RECHECK ${weld}`,
  ].join("\n");
  const refDocx = await docxFromLines([
    `Inspection Review — ${unit}`,
    `Governing standard: ${clause}`,
    `Measured minimum wall thickness: ${measured.toFixed(1)} mm vs allowable ${minWall.toFixed(1)} mm.`,
    `Inspector note: RECHECK ${weld}.`,
    `Disposition: HOLD_FOR_REPAIR.`,
  ]);
  return {
    id: `sop-check-note/${seed}`,
    family: "sop-check-note",
    seed,
    tier: "core",
    mode: "work",
    prompt: [
      `Read the attached inspection report for unit ${unit}, check it against the pressure equipment SOP in the knowledge base, and generate a Word deliverable named \`approval-note.docx\`.`,
      `The note must cite the governing SOP clause ID, state the measured thickness (${measured.toFixed(1)} mm) and the minimum threshold from the SOP, mention the weld note, and record the required disposition code from the SOP.`,
    ].join("\n"),
    attachments: { "inspection-report.md": report },
    knowledgeBase: { "pressure-sop.md": sop },
    reference: { artifacts: { "approval-note.docx": refDocx }, assistantText: `${unit} fails ${clause}; HOLD_FOR_REPAIR.` },
    oracles: [
      {
        type: "deliverable",
        filename: "approval-note\\.docx$",
        facts: [
          { kind: "contains", value: unit },
          { kind: "contains", value: clause.split(" ")[0] },
          { kind: "contains", value: measured.toFixed(1) },
          { kind: "contains", value: minWall.toFixed(1) },
          { kind: "contains", value: weld },
          { kind: "contains", value: "HOLD_FOR_REPAIR" },
        ],
      },
    ],
    expectation: "complete",
    limits: { timeoutMs: 600000 },
    promptLiterals: [unit, measured.toFixed(1)],
  };
}

/* ───────────── 4. spec-audit (CSV deliverable + KB grounding) ───────────── */

function genSpecAudit(seed: number): TaskInstance {
  const rng = new Rng(seed * 5413 + 17);
  const stdId = `STD-${rng.int(200, 299)}`;
  const minRating = rng.pick([300, 600]);
  const minDn = rng.pick([100, 150]);
  const valves = [
    { tag: `XV-${rng.int(101, 149)}`, rating: minRating - 150, dn: minDn, ok: false },
    { tag: `XV-${rng.int(150, 199)}`, rating: minRating, dn: minDn - 25, ok: false },
    { tag: `XV-${rng.int(200, 249)}`, rating: minRating, dn: minDn, ok: true },
    { tag: `XV-${rng.int(250, 299)}`, rating: minRating + 300, dn: minDn + 50, ok: true },
  ];
  const register = ["tag,rating_class,dn_mm", ...valves.map((v) => `${v.tag},${v.rating},${v.dn}`)].join("\n") + "\n";
  const kb = `# Piping Specification ${stdId}\n- High-pressure manifold valves must have rating_class >= ${minRating} and nominal diameter dn_mm >= ${minDn}.\n- Record status as COMPLIANT or NON_COMPLIANT.\n`;
  const out = ["tag,status", ...valves.map((v) => `${v.tag},${v.ok ? "COMPLIANT" : "NON_COMPLIANT"}`)].join("\n") + "\n";
  return {
    id: `spec-audit/${seed}`,
    family: "spec-audit",
    seed,
    tier: "core",
    mode: "work",
    prompt: [
      `Check every valve in \`valve-register.csv\` against the piping specification in the knowledge base.`,
      `Emit a CSV deliverable named \`compliance-audit.csv\` with exact columns \`tag,status\`, where \`status\` is \`COMPLIANT\` or \`NON_COMPLIANT\`.`,
    ].join("\n"),
    attachments: { "valve-register.csv": register },
    knowledgeBase: { "piping-spec.md": kb },
    reference: { artifacts: { "compliance-audit.csv": out }, assistantText: `Audited ${valves.length} valves against ${stdId}.` },
    oracles: [
      {
        type: "deliverable",
        filename: "compliance-audit\\.csv$",
        facts: [
          { kind: "rowCount", count: valves.length },
          ...valves.map((v): Fact => ({ kind: "row", where: { tag: v.tag }, expect: { status: v.ok ? "COMPLIANT" : "NON_COMPLIANT" } })),
        ],
      },
    ],
    expectation: "complete",
    limits: { timeoutMs: 600000 },
    promptLiterals: ["COMPLIANT", "NON_COMPLIANT"],
  };
}

export const ledgerVariance: TaskFamily = {
  id: "ledger-variance",
  tier: "core",
  mode: "work",
  description: "Filter CLEARED ledger rows, compare with department budgets, and emit a verified variance-summary.csv deliverable.",
  devSeeds: [1, 2, 3, 4, 5, 6],
  generate: genLedger,
};

export const telemetryAnomaly: TaskFamily = {
  id: "telemetry-anomaly",
  tier: "core",
  mode: "work",
  description: "Extract sensor readings above a threshold into anomaly-register.csv.",
  devSeeds: [1, 2, 3, 4, 5, 6],
  generate: genTelemetry,
};

export const sopCheckNote: TaskFamily = {
  id: "sop-check-note",
  tier: "core",
  mode: "work",
  description: "Cross-check an inspection report against a KB SOP and generate a grounded Word approval-note.docx.",
  devSeeds: [1, 2, 3, 4, 5, 6],
  generate: genSopNote,
};

export const specAudit: TaskFamily = {
  id: "spec-audit",
  tier: "core",
  mode: "work",
  description: "Audit a valve register against a KB piping spec and emit compliance-audit.csv.",
  devSeeds: [1, 2, 3, 4, 5, 6],
  generate: genSpecAudit,
};
