const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const results = [];
for (const profile of ['default', 'roomy', 'bounded']) for (let trial = 1; trial <= 3; trial++) {
  const dir = path.join(root, 'trials', `${profile}-${trial}`);
  const old = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const records = fs.readFileSync(path.join(dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const working = records.filter((r) => r.purpose.startsWith('working_'));
  const classification = records.filter((r) => r.purpose === 'classification');
  const tools = working.flatMap((r) => r.toolCalls.map((t) => t.name));
  const flowLog = fs.readFileSync(path.join(dir, 'flow-b.log'), 'utf8');
  const entry = {
    profile, trial,
    totalFlowWallSeconds: old.flowWallSeconds,
    processWallMs: old.wallMs,
    outcome: old.outcome,
    acceptanceChecksPassed: old.strictChecksPassed,
    acceptanceChecksFailed: old.strictChecksFailed,
    accepted: old.exitCode === 0,
    modelCalls: { classifier: classification.length, working: working.length, total: records.length },
    workingCompletionTokens: working.reduce((n, r) => n + (r.usage?.completion_tokens ?? 0), 0),
    workingReasoningTokens: working.reduce((n, r) => n + (r.usage?.completion_tokens_details?.reasoning_tokens ?? 0), 0),
    totalCompletionTokens: records.reduce((n, r) => n + (r.usage?.completion_tokens ?? 0), 0),
    totalReasoningTokens: records.reduce((n, r) => n + (r.usage?.completion_tokens_details?.reasoning_tokens ?? 0), 0),
    toolSequence: tools,
    repeatedWriteAttempts: Math.max(0, tools.filter((t) => t === 'write_file').length - 1),
    failedToolResults: (flowLog.match(/Tool Result: [^\n]+\(FAILED\)/g) ?? []).length,
    lengthTerminatedCalls: records.filter((r) => r.finishReason === 'length').length,
    perCall: records.map((r) => ({ purpose: r.purpose, durationMs: r.durationMs, finishReason: r.finishReason,
      promptTokens: r.usage?.prompt_tokens, completionTokens: r.usage?.completion_tokens,
      reasoningTokens: r.usage?.completion_tokens_details?.reasoning_tokens,
      maxTokens: r.generation?.max_tokens, tools: r.toolCalls.map((t) => t.name) })),
  };
  results.push(entry);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(entry, null, 2));
}
const avg = (list, field) => list.reduce((sum, r) => sum + r[field], 0) / list.length;
const groups = ['default', 'roomy', 'bounded'].map((profile) => {
  const trials = results.filter((r) => r.profile === profile);
  return { profile, n: trials.length, meanWallSeconds: +avg(trials, 'totalFlowWallSeconds').toFixed(1),
    minWallSeconds: Math.min(...trials.map((r) => r.totalFlowWallSeconds)), maxWallSeconds: Math.max(...trials.map((r) => r.totalFlowWallSeconds)),
    meanWorkingCalls: +avg(trials.map((r) => ({ x: r.modelCalls.working })), 'x').toFixed(2),
    meanWorkingCompletionTokens: +avg(trials, 'workingCompletionTokens').toFixed(0),
    meanWorkingReasoningTokens: +avg(trials, 'workingReasoningTokens').toFixed(0),
    accepted: trials.filter((r) => r.accepted).length,
    failedToolResults: trials.reduce((n, r) => n + r.failedToolResults, 0),
    repeatedWriteAttempts: trials.reduce((n, r) => n + r.repeatedWriteAttempts, 0),
    lengthTerminatedCalls: trials.reduce((n, r) => n + r.lengthTerminatedCalls, 0),
    toolSequences: trials.map((r) => r.toolSequence.join(' → ')),
    caps: [...new Set(trials.flatMap((r) => r.perCall.filter((c) => c.purpose.startsWith('working_')).map((c) => c.maxTokens)))].join(', '),
  };
});
fs.writeFileSync(path.join(root, 'benchmark-results.json'), JSON.stringify({ profiles: groups, trials: results }, null, 2));
console.log(JSON.stringify(groups, null, 2));
