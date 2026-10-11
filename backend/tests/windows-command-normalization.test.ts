import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/main/tools/python-runtime.js", async () => ({
  ...await vi.importActual<typeof import("../src/main/tools/python-runtime.js")>("../src/main/tools/python-runtime.js"),
  getPythonExecutable: () => "C:\\Python With Spaces\\python.exe",
}));
import { normalizeRunCommandArgs } from "../src/main/tools/workspace-tools.js";
const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", descriptor));
describe("Windows workspace Python commands", () => {
  it("encodes multiline Python before approval without Unix shell syntax", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const code = String.raw`import module
assert module.read('field,value\n"quoted, field",17\n') == [{'field':'quoted, field','value':'17'}]
print('CHECK_OK: %PATH% & $HOME')`;
    const args = { command: "python3 -B", python_code: code };
    const normalized = normalizeRunCommandArgs(args);
    const command = String(normalized.command);
    expect(command.startsWith('"C:\\Python With Spaces\\python.exe" -B -c "')).toBe(true);
    expect(command).not.toContain("<<"); expect(command).not.toContain("%PATH%"); expect(command).not.toContain("\n");
    const encoded = command.match(/b64decode\('([^']+)'\)/)![1];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toContain(code);
    expect(normalizeRunCommandArgs(normalized)).toEqual(normalized);
  });
  it.each(["python3", "python", "python.exe", "python3.exe"])("uses the resolved interpreter for ordinary %s commands", binary => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const args = { command: `${binary} -B "script with spaces.py"` };
    const normalized = normalizeRunCommandArgs(args);
    expect(normalized.command).toBe('"C:\\Python With Spaces\\python.exe" -B "script with spaces.py"');
    expect(normalizeRunCommandArgs(normalized)).toEqual(normalized);
  });
});
