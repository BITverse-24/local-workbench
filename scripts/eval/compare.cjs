const fs = require("node:fs");
const path = require("node:path");

function loadResult(filePath) {
  const fullPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Result file not found: ${fullPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function summarize(results) {
  const tasks = results.tasks || [];
  let totalRuns = 0;
  let passedRuns = 0;
  const callsByRole = {};
  const stopReasons = {};
  const taskMap = new Map();
  const durations = [];

  for (const t of tasks) {
    const runs = t.runs || [t];
    let taskPassed = false;
    for (const r of runs) {
      totalRuns++;
      if (r.pass) {
        passedRuns++;
        taskPassed = true;
      }
      if (r.wallMs) durations.push(r.wallMs);

      const sr = r.stopReason || "unknown";
      stopReasons[sr] = (stopReasons[sr] || 0) + 1;

      if (r.callsByRole) {
        for (const [role, count] of Object.entries(r.callsByRole)) {
          callsByRole[role] = (callsByRole[role] || 0) + count;
        }
      }
    }
    taskMap.set(t.id, { passed: taskPassed, runs });
  }

  durations.sort((a, b) => a - b);
  const medianDuration = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  const passRate = totalRuns ? (passedRuns / totalRuns) * 100 : 0;

  return {
    totalTasks: tasks.length,
    totalRuns,
    passedRuns,
    passRate,
    medianDuration,
    callsByRole,
    stopReasons,
    taskMap
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: node scripts/eval/compare.cjs <baseline.json> <candidate.json>");
    process.exit(1);
  }

  const baselineData = loadResult(args[0]);
  const candidateData = loadResult(args[1]);

  const base = summarize(baselineData);
  const cand = summarize(candidateData);

  console.log("\n=======================================================");
  console.log("PAIRED EVALUATION COMPARISON");
  console.log("=======================================================");
  console.log(`Baseline:  ${args[0]} (Model: ${baselineData.model || "unknown"})`);
  console.log(`Candidate: ${args[1]} (Model: ${candidateData.model || "unknown"})`);
  console.log("-------------------------------------------------------");

  const diffPp = cand.passRate - base.passRate;
  const diffSign = diffPp >= 0 ? "+" : "";
  console.log(`Pass Rate:       ${base.passRate.toFixed(1)}% -> ${cand.passRate.toFixed(1)}% (${diffSign}${diffPp.toFixed(1)} pp)`);
  console.log(`Passed Runs:     ${base.passedRuns}/${base.totalRuns} -> ${cand.passedRuns}/${cand.totalRuns}`);
  console.log(`Median Wall Ms:  ${base.medianDuration}ms -> ${cand.medianDuration}ms (${cand.medianDuration - base.medianDuration >= 0 ? "+" : ""}${cand.medianDuration - base.medianDuration}ms)`);

  console.log("\n--- CALLS BY ROLE ---");
  const allRoles = new Set([...Object.keys(base.callsByRole), ...Object.keys(cand.callsByRole)]);
  console.log(
    "Role".padEnd(20) +
    "Baseline".padStart(10) +
    "Candidate".padStart(12) +
    "Delta".padStart(10) +
    "% Change".padStart(12)
  );
  console.log("-".repeat(64));

  let totalBaseCalls = 0;
  let totalCandCalls = 0;

  for (const role of Array.from(allRoles).sort()) {
    const bCount = base.callsByRole[role] || 0;
    const cCount = cand.callsByRole[role] || 0;
    totalBaseCalls += bCount;
    totalCandCalls += cCount;
    const delta = cCount - bCount;
    const pct = bCount > 0 ? `${((delta / bCount) * 100).toFixed(1)}%` : "N/A";
    console.log(
      role.padEnd(20) +
      String(bCount).padStart(10) +
      String(cCount).padStart(12) +
      (delta >= 0 ? `+${delta}` : String(delta)).padStart(10) +
      pct.padStart(12)
    );
  }
  console.log("-".repeat(64));
  const totalDelta = totalCandCalls - totalBaseCalls;
  const totalPct = totalBaseCalls > 0 ? `${((totalDelta / totalBaseCalls) * 100).toFixed(1)}%` : "N/A";
  console.log(
    "TOTAL".padEnd(20) +
    String(totalBaseCalls).padStart(10) +
    String(totalCandCalls).padStart(12) +
    (totalDelta >= 0 ? `+${totalDelta}` : String(totalDelta)).padStart(10) +
    totalPct.padStart(12)
  );

  console.log("\n--- STOP REASONS ---");
  const allReasons = new Set([...Object.keys(base.stopReasons), ...Object.keys(cand.stopReasons)]);
  for (const reason of Array.from(allReasons).sort()) {
    const b = base.stopReasons[reason] || 0;
    const c = cand.stopReasons[reason] || 0;
    console.log(`${reason.padEnd(30)}: baseline=${b}, candidate=${c} (delta: ${c - b >= 0 ? "+" : ""}${c - b})`);
  }

  console.log("\n--- PER-TASK PAIRED DELTA ---");
  const improved = [];
  const regressed = [];
  const same = [];

  for (const [id, bTask] of base.taskMap.entries()) {
    const cTask = cand.taskMap.get(id);
    if (!cTask) continue;
    if (!bTask.passed && cTask.passed) improved.push(id);
    else if (bTask.passed && !cTask.passed) regressed.push(id);
    else same.push(id);
  }

  console.log(`Improved  (+): ${improved.length} tasks ${improved.length ? `[${improved.join(", ")}]` : ""}`);
  console.log(`Regressed (-): ${regressed.length} tasks ${regressed.length ? `[${regressed.join(", ")}]` : ""}`);
  console.log(`Unchanged (=): ${same.length} tasks`);
  console.log("=======================================================\n");
}

main();
