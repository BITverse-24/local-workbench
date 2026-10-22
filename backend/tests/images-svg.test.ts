import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractSvgText } from "../src/main/run/images.js";

describe("extractSvgText", () => {
  it("extracts SVG labels without inventing the embedded image rating", () => {
    const svgPath = path.resolve(__dirname, "../../demo/flow_c/scenario-1/pump-skid-P204.svg");
    const svgBuffer = readFileSync(svgPath);
    const extracted = extractSvgText(svgBuffer);

    expect(extracted).toContain("P-204 PUMP SKID - DESIGN REVIEW DRAWING");
    expect(extracted).toContain("Drawing: PID-P204-REV-C");
    expect(extracted).toContain("DN100 suction");
    expect(extracted).toContain("DN80 discharge");
    expect(extracted).toContain("P-204");
    expect(extracted).toContain("XV-204");
    expect(extracted).not.toContain("CLASS 150");
    expect(extracted).toContain("valve rating");
    expect(extracted).toContain("DN80");
    expect(extracted).toContain("discharge");
    expect(extracted).not.toContain("SOP-220");
  });

  it("handles nested tspans, xml entities, and titles in arbitrary SVGs", () => {
    const customSvg = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg">
        <title>Reactor Vessel &amp; Piping</title>
        <text x="10" y="20">
          <tspan font-weight="bold">TK-101</tspan>
          <tspan fill="red">Level &gt; 85%</tspan>
        </text>
        <text x="10" y="40">Temp &lt; 150&#176;C</text>
      </svg>
    `);

    const extracted = extractSvgText(customSvg);
    expect(extracted).toContain("Reactor Vessel & Piping");
    expect(extracted).toContain("TK-101 Level > 85%");
    expect(extracted).toContain("Temp < 150°C");
  });
});
