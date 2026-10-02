import { describe, it, expect } from "vitest";
import { resolveSemanticIntent, SEMANTIC_ROUTER_SYSTEM_PROMPT } from "../src/main/router/contextual-router.js";
import { deriveOutputExpectation } from "../src/main/router/output-expectation.js";
import { evaluateCompletionOutcome, detectRequestedDeliverables } from "../src/main/agent/agent-loop.js";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";

describe("Live Local Model Intent Resolution Verification", () => {
  it("resolves natural language intentions, negative constraints, and output expectations against live LM Studio endpoint", async () => {
    const liveUrl = "http://127.0.0.1:1234/v1/chat/completions";
    const userPrompt = "Update notes.md. Do not modify config.json, unrelated.md, or any other existing file.";
    const workspaceFiles = ["notes.md", "config.json", "unrelated.md", "package.json", "src/index.ts"];

    // Probe if live endpoint is reachable (skip gracefully in sandbox or offline environment)
    let isReachable = false;
    try {
      const probe = await fetch("http://127.0.0.1:1234/v1/models", { signal: AbortSignal.timeout(500) });
      isReachable = probe.ok;
    } catch {
      isReachable = false;
    }

    if (!isReachable) {
      console.log("LM Studio endpoint is not reachable (sandbox or server offline). Skipping live test.");
      return;
    }

    // 1. Live model gateway wrapper
    const liveGateway = {
      async execute(req: any) {
        const resp = await fetch(liveUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "qwen2.5-coder-7b-instruct-mlx",
            messages: [
              { role: "system", content: req.systemPrompt },
              { role: "user", content: req.userPrompt },
            ],
            temperature: 0.0,
            max_tokens: 512,
          }),
        });

        if (!resp.ok) {
          throw new Error(`LM Studio returned ${resp.status}: ${await resp.text()}`);
        }

        const data = (await resp.json()) as any;
        return {
          ok: true,
          value: {
            result: {
              text: data.choices[0].message.content,
            },
          },
        };
      },
    };

    console.log("\n=======================================================");
    console.log("=== 1. DISPATCHING PROMPT TO LIVE LOCAL MODEL ===");
    console.log(`Prompt: "${userPrompt}"`);

    // 2. Full pipeline execution
    const validatedIntent = await resolveSemanticIntent(
      {
        userPrompt,
        hasWorkspace: true,
        workspaceFiles,
        history: [],
      },
      liveGateway as any,
    );

    console.log("\n=== 2. NORMALIZED CONTRACT (ValidatedSemanticIntent) ===");
    console.log(JSON.stringify(validatedIntent, null, 2));

    // Verify model extracted the correct semantic intent
    expect(validatedIntent.status).toBe("resolved");
    expect(validatedIntent.workspaceMutationRequested).toBe(true);
    expect(validatedIntent.targetFiles).toContain("notes.md");
    expect(validatedIntent.expectedDeliverables).toEqual([]);
    expect(validatedIntent.protectedPaths).toContain("config.json");
    expect(validatedIntent.protectedPaths).toContain("unrelated.md");
    expect(validatedIntent.restrictMutationsToTargets).toBe(true);

    // 3. Derived output expectation
    console.log("\n=== 3. DERIVED OUTPUT EXPECTATION ===");
    const outputExpectation = deriveOutputExpectation(validatedIntent);
    console.log(JSON.stringify(outputExpectation, null, 2));

    expect(outputExpectation.chatResponse).toBe(true);
    expect(outputExpectation.expectedFiles).toEqual([]);
    expect(outputExpectation.workspaceMutationRequested).toBe(true);
    expect(outputExpectation.targetFiles).toContain("notes.md");
    expect(outputExpectation.expectedDeliverables).toEqual([]);
    expect(outputExpectation.protectedPaths).toContain("config.json");
    expect(outputExpectation.protectedPaths).toContain("unrelated.md");
    expect(outputExpectation.restrictMutationsToTargets).toBe(true);

    // 4. Mutation Policy Guard Enforcement
    console.log("\n=== 4. MUTATION POLICY GUARD ENFORCEMENT ===");
    const guard = new MutationPolicyGuard();
    const runId = "live-verify-run";
    guard.setProtectedPaths(runId, validatedIntent.protectedPaths);
    guard.setMutationTargetRestriction(runId, validatedIntent.restrictMutationsToTargets, validatedIntent.targetFiles);

    const testNotes = guard.isAuthorized(runId, "write_file", { path: "notes.md" });
    const testConfig = guard.isAuthorized(runId, "write_file", { path: "config.json" });
    const testUnrelated = guard.isAuthorized(runId, "write_file", { path: "unrelated.md" });
    const testPackage = guard.isAuthorized(runId, "write_file", { path: "package.json" });

    console.log(`write_file "notes.md": ${testNotes} (EXPECTED: true)`);
    console.log(`write_file "config.json": ${testConfig} (EXPECTED: false - protected)`);
    console.log(`write_file "unrelated.md": ${testUnrelated} (EXPECTED: false - protected)`);
    console.log(`write_file "package.json": ${testPackage} (EXPECTED: false - restricted)`);

    expect(testNotes).toBe(true);
    expect(testConfig).toBe(false);
    expect(testUnrelated).toBe(false);
    expect(testPackage).toBe(false);

    // 5. Completion Truthfulness Evaluation
    console.log("\n=== 5. COMPLETION TRUTHFULNESS EVALUATION ===");
    const requestedDeliverables = detectRequestedDeliverables(userPrompt, validatedIntent);
    const completionSuccess = evaluateCompletionOutcome(
      requestedDeliverables,
      new Set(["notes.md"]),
      false,
      false,
      false,
      {
        expectedMutations: validatedIntent.targetFiles,
        actualModifiedFiles: new Set(["notes.md"]),
      },
    );
    console.log(`Scenario A (notes.md written, no deliverables expected): ${completionSuccess.outcome}`);
    expect(completionSuccess.outcome).toBe("completed");
    expect(completionSuccess.missingDeliverables).toEqual([]);
    expect(completionSuccess.producedMutations).toContain("notes.md");

    const completionPartial = evaluateCompletionOutcome(
      requestedDeliverables,
      new Set(),
      false,
      false,
      false,
      {
        expectedMutations: validatedIntent.targetFiles,
        actualModifiedFiles: new Set(),
      },
    );
    console.log(`Scenario B (model stopped in text without notes.md modified): ${completionPartial.outcome}`);
    expect(completionPartial.outcome).toBe("partial");
    expect(completionPartial.missingMutations).toContain("notes.md");
    console.log("=======================================================\n");
  }, 30000);
});
