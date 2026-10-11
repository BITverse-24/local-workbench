import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), bwrap: vi.fn() }));
vi.mock("../src/main/tools/child-process.js", () => ({ executeProcess: mocks.exec }));
vi.mock("../src/main/tools/python-runtime.js", async () => ({ ...await vi.importActual<typeof import("../src/main/tools/python-runtime.js")>("../src/main/tools/python-runtime.js"), findBubblewrap: mocks.bwrap }));
import { getCommandCapability, runCommand } from "../src/main/harness/tools/run-command.js";
const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "command-support-")); writeFileSync(path.join(root, "input.txt"), "ORIGINAL"); mocks.exec.mockReset(); mocks.bwrap.mockReset(); });
afterEach(() => { Object.defineProperty(process, "platform", descriptor); rmSync(root, { recursive: true, force: true }); });
const platform = (value: string) => Object.defineProperty(process, "platform", { configurable: true, value });
describe("Command capability portability", () => {
  it("reports Windows commands as unavailable before executing user code", async () => {
    platform("win32"); const status = await getCommandCapability();
    expect(status.status).toBe("unavailable"); expect(status.message).toContain("Windows");
    await expect(runCommand(root, "echo changed > input.txt")).rejects.toThrow(/Windows/);
    expect(mocks.exec).not.toHaveBeenCalled(); expect(readFileSync(path.join(root, "input.txt"), "utf8")).toBe("ORIGINAL");
  });
  it("explains Linux bubblewrap prerequisites when missing", async () => {
    platform("linux"); mocks.bwrap.mockReturnValue(undefined);
    expect(await getCommandCapability()).toMatchObject({ status: "unavailable", message: expect.stringContaining("user namespaces") });
    await expect(runCommand(root, "echo changed > input.txt")).rejects.toThrow(/bubblewrap/); expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("reports a failed Linux probe and refuses the real command", async () => {
    platform("linux"); mocks.bwrap.mockReturnValue("/usr/bin/bwrap"); mocks.exec.mockImplementation(async (_command, _args, options) => { expect(readdirSync(options.cwd)).toEqual([]); throw new Error("user namespaces disabled"); });
    const status = await getCommandCapability(); expect(status.status).toBe("unavailable"); expect(status.message).toContain("user namespaces disabled");
    await expect(runCommand(root, "echo changed > input.txt")).rejects.toThrow(/No command was executed/);
    expect(mocks.exec).toHaveBeenCalledTimes(2);
    for (const call of mocks.exec.mock.calls) { expect(call[1]).toContain("--unshare-all"); expect(call[1]).not.toContain("echo changed > input.txt"); }
    expect(readFileSync(path.join(root, "input.txt"), "utf8")).toBe("ORIGINAL");
  });
  it("advertises Linux command support only after a successful probe", async () => {
    platform("linux"); mocks.bwrap.mockReturnValue("/opt/tools/bwrap"); mocks.exec.mockResolvedValue({ stdout: "WORKBENCH_ISOLATED", stderr: "" });
    expect((await getCommandCapability()).status).toBe("os_isolated"); expect(mocks.exec.mock.calls[0][0]).toBe("/opt/tools/bwrap");
  });
  it("rejects invalid Linux probe output", async () => {
    platform("linux"); mocks.bwrap.mockReturnValue("/usr/bin/bwrap"); mocks.exec.mockResolvedValue({ stdout: "unexpected", stderr: "" });
    expect((await getCommandCapability()).status).toBe("unavailable");
  });
});
