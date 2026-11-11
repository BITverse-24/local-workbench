import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFileSync } from "../src/main/agent/symbol-index.js";
import { checkBufferSyntax, validateProposalSyntax } from "../src/main/agent/codeintel/diagnostics.js";
import { bindSymbolEdit } from "../src/main/agent/symbol-edit.js";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("T8 Phase C — Polyglot Adapters (Java, C/C++, C#) & replace_symbol", () => {
  it("parses Java classes, methods, annotations, imports, and references", () => {
    const javaSrc = Buffer.from(
      [
        "package com.example.billing;",
        "",
        "import java.math.BigDecimal;",
        "import com.example.tax.TaxRateProvider;",
        "",
        "public class InvoiceCalculator {",
        "    @Override",
        "    public BigDecimal computeTotal(BigDecimal netAmount) {",
        "        BigDecimal tax = TaxRateProvider.computeTax(netAmount);",
        "        return netAmount.add(tax);",
        "    }",
        "",
        "    private boolean isValid(BigDecimal netAmount) {",
        "        return netAmount != null && netAmount.signum() >= 0;",
        "    }",
        "}",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseFileSync("src/main/java/com/example/billing/InvoiceCalculator.java", javaSrc);
    expect(parsed.imports).toEqual([
      { from: "java.math.BigDecimal", names: ["BigDecimal"], line: 3 },
      { from: "com.example.tax.TaxRateProvider", names: ["TaxRateProvider"], line: 4 },
    ]);
    expect(parsed.symbols.map((s) => ({ name: s.name, kind: s.kind, startLine: s.startLine, endLine: s.endLine }))).toEqual([
      { name: "InvoiceCalculator", kind: "class", startLine: 6, endLine: 16 },
      { name: "InvoiceCalculator.computeTotal", kind: "method", startLine: 7, endLine: 11 },
      { name: "InvoiceCalculator.isValid", kind: "method", startLine: 13, endLine: 15 },
    ]);
    expect(parsed.refs.some((r) => r.name === "computeTax" && r.kind === "call")).toBe(true);
    expect(checkBufferSyntax("InvoiceCalculator.java", javaSrc)).toEqual([]);
  });

  it("parses C and C++ headers, classes, free functions, qualified methods, and #include directives", () => {
    const cppSrc = Buffer.from(
      [
        '#include "telemetry/sensor.h"',
        "#include <vector>",
        "",
        "class PressureMonitor {",
        "public:",
        "    double clampPressure(double psi) const {",
        "        return psi < 0.0 ? 0.0 : psi;",
        "    }",
        "};",
        "",
        "double SensorAggregator::averageReading(const std::vector<double>& samples) {",
        "    if (samples.empty()) return 0.0;",
        "    double sum = 0.0;",
        "    for (double v : samples) sum += clampValue(v);",
        "    return sum / samples.size();",
        "}",
        "",
        "int computeChecksum(int seed, int value) {",
        "    return (seed * 31) ^ value;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseFileSync("src/monitor.cpp", cppSrc);
    expect(parsed.imports).toEqual([
      { from: "telemetry/sensor.h", names: ["sensor"], line: 1 },
      { from: "vector", names: ["vector"], line: 2 },
    ]);
    expect(parsed.symbols.map((s) => ({ name: s.name, kind: s.kind }))).toEqual([
      { name: "PressureMonitor", kind: "class" },
      { name: "PressureMonitor.clampPressure", kind: "method" },
      { name: "SensorAggregator.averageReading", kind: "method" },
      { name: "computeChecksum", kind: "function" },
    ]);
    expect(parsed.refs.some((r) => r.name === "clampValue" && r.kind === "call")).toBe(true);
    expect(checkBufferSyntax("src/monitor.cpp", cppSrc)).toEqual([]);
  });

  it("parses C# using directives, namespaces, classes, attributes, and methods", () => {
    const csSrc = Buffer.from(
      [
        "using System;",
        "using MyCorp.Ledger;",
        "",
        "namespace MyCorp.Invoicing",
        "{",
        "    public class DiscountEngine",
        "    {",
        "        [Obsolete]",
        "        public decimal ApplyDiscount(decimal amount, decimal rate)",
        "        {",
        "            return LedgerMath.RoundCurrency(amount * (1m - rate));",
        "        }",
        "    }",
        "}",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseFileSync("Services/DiscountEngine.cs", csSrc);
    expect(parsed.imports).toEqual([
      { from: "System", names: ["System"], line: 1 },
      { from: "MyCorp.Ledger", names: ["Ledger"], line: 2 },
    ]);
    expect(parsed.symbols.map((s) => ({ name: s.name, kind: s.kind, startLine: s.startLine, endLine: s.endLine }))).toEqual([
      { name: "DiscountEngine", kind: "class", startLine: 6, endLine: 13 },
      { name: "DiscountEngine.ApplyDiscount", kind: "method", startLine: 8, endLine: 12 },
    ]);
    expect(parsed.refs.some((r) => r.name === "RoundCurrency" && r.kind === "call")).toBe(true);
    expect(checkBufferSyntax("Services/DiscountEngine.cs", csSrc)).toEqual([]);
  });

  it("lowers replace_symbol on Java, C++, and C# files and rejects broken syntax", async () => {
    const javaBytes = Buffer.from(
      [
        "public class MathUtil {",
        "    public static int add(int a, int b) {",
        "        return a - b;",
        "    }",
        "}",
      ].join("\n"),
      "utf8",
    );
    const source = {
      path: "src/main/java/MathUtil.java",
      digest: sha256(javaBytes),
      focusKey: "k1",
      expanded: false,
    };

    const valid = await bindSymbolEdit(
      {
        id: "c1",
        name: "replace_symbol",
        arguments: {
          edits: [
            {
              symbol: "MathUtil.add",
              new_source: "public static int add(int a, int b) {\n    return a + b;\n}",
            },
          ],
        },
      },
      source,
      javaBytes,
    );
    expect("call" in valid).toBe(true);
    if ("call" in valid) {
      expect(valid.call.name).toBe("edit_file");
      const reps = (valid.call.arguments as any).replacements;
      expect(reps[0].old).toContain("return a - b;");
      expect(reps[0].new).toContain("    public static int add(int a, int b) {");
      expect(reps[0].new).toContain("return a + b;");
    }

    // Broken syntax in Java/C++/C# replacement is rejected before edit_file
    await expect(
      bindSymbolEdit(
        {
          id: "c2",
          name: "replace_symbol",
          arguments: {
            edits: [
              {
                symbol: "MathUtil.add",
                new_source: "public static int add(int a, int b) {\n    return a + ;\n",
              },
            ],
          },
        },
        source,
        javaBytes,
      ),
    ).rejects.toThrow(/Syntax error in replacement/);

    // Pre-approval syntax gate also catches unclosed braces/strings in C#
    expect(() =>
      validateProposalSyntax(
        "Services/DiscountEngine.cs",
        Buffer.from("class A { int M() { return 1; } }\n", "utf8"),
        Buffer.from("class A { int M() { return 1; }\n", "utf8"),
      ),
    ).toThrow(/syntax error/i);
  });
});
