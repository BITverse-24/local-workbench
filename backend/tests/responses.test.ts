import { describe, expect, it } from "vitest";
import { validateCode, validateChat } from "../src/main/validators/responses.js";
import { extractJsonFromText, normalizeResponse, parseProviderContent } from "../src/main/gateway/normalizer.js";

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

  it("accepts empty string artifact metadata for a chat-only response (from local LLMs)", () => {
    const result = validateCode({
      filename: "task.py",
      source: "import csv\nwith open('input.csv', newline='') as handle:\n    print(sum(1 for _ in csv.DictReader(handle)))",
      expectedResult: "Prints the number of CSV rows.",
      inputFiles: ["input.csv"],
      outputFiles: [],
      allowedImports: ["csv"],
      outputMode: "chat",
      artifactKind: "",
      artifactFilename: "",
      artifactRationale: "",
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

  it("accepts an artifact response with a text file", () => {
    const result = validateCode({
      filename: "task.py",
      source: "import csv\nwith open('input.csv', newline='') as handle:\n    rows = list(csv.DictReader(handle))\nwith open('summary.txt', 'w') as out:\n    out.write(str(len(rows)))",
      expectedResult: "Writes the number of CSV rows to a text file.",
      inputFiles: ["input.csv"],
      outputFiles: ["summary.txt"],
      allowedImports: ["csv"],
      outputMode: "artifact",
      artifactKind: "txt",
      artifactFilename: "summary.txt",
      artifactRationale: "Requested text file",
    });
    expect(result.ok).toBe(true);
  });

describe("chat response validation and normalization", () => {
  it("accepts standard text response", () => {
    const res = validateChat({ text: "Hello there!" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.text).toBe("Hello there!");
  });

  it("coerces numeric values to string (e.g. pick a number)", () => {
    const res = validateChat({ text: 7 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.text).toBe("7");
  });

  it("accepts alternative keys emitted by models", () => {
    expect(validateChat({ answer: 42 }).ok).toBe(true);
    expect(validateChat({ message: "Welcome" }).ok).toBe(true);
    expect(validateChat({ response: "Done" }).ok).toBe(true);
    expect(validateChat({ number: 7 }).ok).toBe(true);
  });

  it("accepts raw string text", () => {
    const res = validateChat("Just plain text");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.text).toBe("Just plain text");
  });

  it("rejects empty object with informative error message", () => {
    const res = validateChat({});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("field 'text'");
    }
  });

  it("extracts JSON from reasoning when content is empty object", () => {
    const reasoning = 'Okay, user asked for a number between 1 and 10. If the number is 7, the JSON would be {"text": "7"}. All done.';
    const extracted = parseProviderContent("{\n\n}", reasoning);
    expect(extracted).toEqual({ text: "7" });
  });

  it("extracts JSON from reasoning when content is empty string", () => {
    const reasoning = 'Thinking... Here is the result: {"text": "Hello world"}';
    const extracted = parseProviderContent("", reasoning);
    expect(extracted).toEqual({ text: "Hello world" });
  });

  it("normalizes chat response with number or alt keys", () => {
    const dummyReq = {
      requestId: "r1",
      runId: "run1",
      modelId: "draft-qwen3" as const,
      taskType: "draft" as const,
      responseFormat: "chat-result" as const,
      systemPrompt: "sys",
      userPrompt: "prompt",
      timeoutMs: 1000,
    };
    const norm1 = normalizeResponse({ text: 7 }, dummyReq);
    expect(norm1.result).toEqual({ text: "7" });

    const norm2 = normalizeResponse({ number: 7 }, dummyReq);
    expect(norm2.result).toEqual({ text: "7" });

    const norm3 = normalizeResponse({ answer: "forty-two" }, dummyReq);
    expect(norm3.result).toEqual({ text: "forty-two" });
  });
});


