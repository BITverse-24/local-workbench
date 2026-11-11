import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentVerificationRequest,
  discoverAgentTestPlans,
  parseAgentTestReport,
} from "../src/main/agent/test-verification.js";
import { captureCommandWorkspaceDigest, commandApprovalDigest, runCommand } from "../src/main/harness/tools/run-command.js";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";
import { withRuntimeScope } from "../src/main/run/runtime-scope.js";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("T8 Phase D — Polyglot Agent Test Discovery & Execution (Java, C/C++, C#)", () => {
  it("discovers Maven and Gradle Java test plans and parses Surefire/Gradle JUnit XML reports", () => {
    const mvnRoot = mkdtempSync(path.join(os.tmpdir(), "polyglot-mvn-"));
    tempDirs.push(mvnRoot);
    mkdirSync(path.join(mvnRoot, "src/main/java/com/example"), { recursive: true });
    mkdirSync(path.join(mvnRoot, "src/test/java/com/example"), { recursive: true });
    writeFileSync(path.join(mvnRoot, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n", "utf8");
    writeFileSync(
      path.join(mvnRoot, "src/main/java/com/example/MathUtil.java"),
      "package com.example;\npublic class MathUtil { public static int add(int a, int b) { return a + b; } }\n",
      "utf8",
    );
    writeFileSync(
      path.join(mvnRoot, "src/test/java/com/example/MathUtilTest.java"),
      "package com.example;\npublic class MathUtilTest {}\n",
      "utf8",
    );

    const mvnDisc = discoverAgentTestPlans({ workspaceRoot: mvnRoot, changedPaths: ["src/main/java/com/example/MathUtil.java"] });
    expect(mvnDisc.ok).toBe(true);
    if (mvnDisc.ok) {
      expect(mvnDisc.plans[0].runner).toBe("maven");
      expect(mvnDisc.plans[0].reportFormat).toBe("junit");
      expect(mvnDisc.plans[0].runtimeTools).toEqual(["java", "mvn"]);
      expect(mvnDisc.plans[0].testFiles).toEqual(["src/test/java/com/example/MathUtilTest.java"]);

      const req = createAgentVerificationRequest(mvnDisc.plans[0]);
      const surefireXml = [
        "<testsuites>",
        '  <testsuite name="com.example.MathUtilTest" tests="2" failures="1" errors="0" skipped="0">',
        '    <testcase classname="com.example.MathUtilTest" name="addsPositive" time="0.01"/>',
        '    <testcase classname="com.example.MathUtilTest" name="addsNegative" time="0.01">',
        '      <failure message="expected 5 but was -5">java.lang.AssertionError at MathUtilTest.java:14</failure>',
        "    </testcase>",
        "  </testsuite>",
        "</testsuites>",
      ].join("\n");
      const parsed = parseAgentTestReport(req, surefireXml, mvnRoot);
      expect(parsed.executed).toBe(2);
      expect(parsed.failed).toBe(1);
      expect(parsed.testFiles).toEqual(["src/test/java/com/example/MathUtilTest.java"]);
      expect(parsed.failureOutput).toContain("addsNegative: expected 5 but was -5");
    }

    const gradleRoot = mkdtempSync(path.join(os.tmpdir(), "polyglot-gradle-"));
    tempDirs.push(gradleRoot);
    mkdirSync(path.join(gradleRoot, "src/test/java"), { recursive: true });
    writeFileSync(path.join(gradleRoot, "build.gradle.kts"), "plugins { java }\n", "utf8");
    writeFileSync(path.join(gradleRoot, "src/test/java/OrderServiceTest.java"), "public class OrderServiceTest {}\n", "utf8");

    const gradleDisc = discoverAgentTestPlans({ workspaceRoot: gradleRoot, changedPaths: [] });
    expect(gradleDisc.ok).toBe(true);
    if (gradleDisc.ok) {
      expect(gradleDisc.plans[0].runner).toBe("gradle");
      expect(gradleDisc.plans[0].runtimeTools).toEqual(["java", "gradle"]);
    }
  });

  it("discovers C# .NET test plans and parses TRX reports", () => {
    const csRoot = mkdtempSync(path.join(os.tmpdir(), "polyglot-dotnet-"));
    tempDirs.push(csRoot);
    mkdirSync(path.join(csRoot, "Tests"), { recursive: true });
    writeFileSync(path.join(csRoot, "Billing.csproj"), '<Project Sdk="Microsoft.NET.Sdk"></Project>\n', "utf8");
    writeFileSync(path.join(csRoot, "DiscountEngine.cs"), "namespace Billing { public class DiscountEngine {} }\n", "utf8");
    writeFileSync(path.join(csRoot, "Tests/DiscountEngineTests.cs"), "namespace Billing.Tests { public class DiscountEngineTests {} }\n", "utf8");

    const disc = discoverAgentTestPlans({ workspaceRoot: csRoot, changedPaths: ["DiscountEngine.cs"] });
    expect(disc.ok).toBe(true);
    if (disc.ok) {
      expect(disc.plans[0].runner).toBe("dotnet");
      expect(disc.plans[0].reportFormat).toBe("trx");
      expect(disc.plans[0].runtimeTools).toEqual(["dotnet"]);

      const req = createAgentVerificationRequest(disc.plans[0]);
      const trx = [
        '<?xml version="1.0" encoding="utf-8"?>',
        "<TestRun>",
        "  <Results>",
        '    <UnitTestResult testName="Billing.Tests.DiscountEngineTests.AppliesRate" outcome="Passed" />',
        '    <UnitTestResult testName="Billing.Tests.DiscountEngineTests.RejectsNegative" outcome="Failed">',
        "      <Output><ErrorInfo><Message>Expected ArgumentException</Message></ErrorInfo></Output>",
        "    </UnitTestResult>",
        "  </Results>",
        "</TestRun>",
      ].join("\n");
      const parsed = parseAgentTestReport(req, trx, csRoot);
      expect(parsed.executed).toBe(2);
      expect(parsed.failed).toBe(1);
      expect(parsed.testFiles).toEqual(["Tests/DiscountEngineTests.cs"]);
      expect(parsed.failureOutput).toContain("Expected ArgumentException");
    }
  });

  it("discovers and executes a real CMake + CTest C++ test suite end-to-end", async () => {
    const cppRoot = mkdtempSync(path.join(os.tmpdir(), "polyglot-ctest-"));
    tempDirs.push(cppRoot);
    mkdirSync(path.join(cppRoot, "tests"), { recursive: true });
    writeFileSync(
      path.join(cppRoot, "CMakeLists.txt"),
      [
        "cmake_minimum_required(VERSION 3.16)",
        "project(SensorMath LANGUAGES CXX)",
        "set(CMAKE_CXX_STANDARD 17)",
        "enable_testing()",
        "add_executable(math_test tests/math_test.cpp)",
        "add_test(NAME MathTest COMMAND math_test)",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(cppRoot, "math_util.h"),
      "#pragma once\ninline int add_values(int a, int b) { return a + b; }\n",
      "utf8",
    );
    writeFileSync(
      path.join(cppRoot, "tests/math_test.cpp"),
      [
        '#include "../math_util.h"',
        "#include <cassert>",
        "int main() {",
        "    assert(add_values(3, 4) == 7);",
        "    return 0;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const disc = discoverAgentTestPlans({ workspaceRoot: cppRoot, changedPaths: ["math_util.h"] });
    expect(disc.ok).toBe(true);
    if (!disc.ok) return;

    expect(disc.plans[0].runner).toBe("ctest");
    const req = createAgentVerificationRequest(disc.plans[0]);
    const guard = new MutationPolicyGuard();
    const runId = "33333333-4444-5555-6666-777777777777";
    guard.setEnforceExplicit(runId, true);
    const approval = { workspaceDigest: captureCommandWorkspaceDigest(cppRoot) };
    const opDigest = commandApprovalDigest(req.command, approval);
    guard.grantScope({ runId, operation: "run_command", command: req.command, operationDigest: opDigest, allowUnisolated: true });

    const res = await withRuntimeScope(
      { runId, mode: "agent", agentPhase: "actions", signal: new AbortController().signal },
      () => runCommand(cppRoot, req.command, 60000, { guard, runId, approval }, req),
    );
    expect(res.exitCode).toBe(0);
    expect(res.verification?.executed).toBe(1);
    expect(res.verification?.failed).toBe(0);
    expect(res.verification?.testFiles).toEqual(["tests/math_test.cpp"]);
  }, 30000);
});
