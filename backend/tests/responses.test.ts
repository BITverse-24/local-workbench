import { describe, expect, it } from "vitest";
import { validateCode } from "../src/main/validators/responses.js";

describe("code response validation", () => {
  it("accepts a print-only CSV analysis", () => {
    const result = validateCode({
      filename: "task.py",
      source: "import csv\nwith open('input.csv', newline='') as handle:\n    rows = list(csv.DictReader(handle))\nprint(len(rows))",
      expectedResult: "Prints the number of CSV rows.",
      inputFiles: ["input.csv"],
      outputFiles: [],
      allowedImports: ["csv"],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts safe math for statistical CSV calculations", () => {
    const result = validateCode({
      filename: "task.py",
      source: "import csv\nimport math\nwith open('input.csv', newline='') as handle:\n    values = [float(row['value']) for row in csv.DictReader(handle)]\nprint(math.sqrt(sum(values)))",
      expectedResult: "Prints a standard deviation.",
      inputFiles: ["input.csv"],
      outputFiles: [],
      allowedImports: ["csv", "math"],
      outputMode: "chat",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts null artifact metadata for a chat-only response", () => {
    const result = validateCode({
      filename: "task.py",
      source: "import csv\nwith open('input.csv', newline='') as handle:\n    print(sum(1 for _ in csv.DictReader(handle)))",
      expectedResult: "Prints the number of CSV rows.",
      inputFiles: ["input.csv"],
      outputFiles: [],
      allowedImports: ["csv"],
      outputMode: "chat",
      artifactKind: null,
      artifactFilename: null,
      artifactRationale: null,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects command-line and unapproved imports", () => {
    const result = validateCode({
      filename: "task.py",
      source: "import sys\nprint(sys.argv)",
      expectedResult: "Prints the arguments.",
      inputFiles: ["input.csv"],
      outputFiles: [],
      allowedImports: ["sys"],
    });
    expect(result.ok).toBe(false);
  });
});
