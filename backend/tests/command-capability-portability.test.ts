import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), bwrap: vi.fn() }));
vi.mock("../src/main/tools/child-process.js", () => ({ executeProcess: mocks.exec }));
vi.mock("../src/main/tools/python-runtime.js", async () => ({ ...await vi.importActual<typeof import("../src/main/tools/python-runtime.js")>("../src/main/tools/python-runtime.js"), findBubblewrap: mocks.bwrap }));
import { getCommandCapability, runCommand } from "../src/main/harness/tools/run-command.js";
import { MutationPolicyGuard } from "../src/main/harness/policy-guard.js";
const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;
const platform = (value: string) => Object.defineProperty(process, "platform", { configurable: true, value });
const command = "echo changed > input.txt";
function approved(allowUnisolated = true) {
  const guard = new MutationPolicyGuard({ strict: true });
  guard.grantScope({ runId: "run", operation: "run_command", command, allowUnisolated });
  return { guard, runId: "run" };
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "command-support-")); writeFileSync(path.join(root, "input.txt"), "ORIGINAL");
  mocks.bwrap.mockReset();
  mocks.exec.mockReset().mockImplementation(async (_binary, args, options) => {
    if (args.includes("printf WORKBENCH_ISOLATED")) throw new Error("user namespaces disabled");
    if (args.at(-1)?.includes("WORKBENCH_COMMAND")) return { stdout: "WORKBENCH_COMMAND\r\n", stderr: "" };
    writeFileSync(path.join(options.cwd, "input.txt"), "changed");
    return { stdout: "checked", stderr: "" };
  });
});
afterEach(() => { Object.defineProperty(process, "platform", descriptor); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
describe("Command capability portability", () => {
  it.each(["win32", "linux", "darwin"])("executes the approved fallback and publishes checked changes on %s", async host => {
    platform(host); vi.stubEnv("WORKBENCH_USE_MAC_SANDBOX", "0");
    const status = await getCommandCapability();
    expect(status.status).toBe("approval_required"); expect(status.message).toContain("user permissions");
    const result = await runCommand(root, command, 5000, approved());
    expect(result.isolationStatus).toBe("unisolated"); expect(result.exitCode).toBe(0);
    expect(result.changes).toEqual(["written:input.txt"]);
    expect(readFileSync(path.join(root, "input.txt"), "utf8")).toBe("changed");
    const call = mocks.exec.mock.calls.at(-1)!;
    expect(call[2].env.HOME).not.toBe(process.env.HOME);
    expect(call[2].cwd).not.toBe(root);
    if (host === "win32") {
      expect(call[0]).toMatch(/System32\\cmd\.exe$/i);
      expect(call[1]).toEqual(["/d", "/s", "/c", `"${command}"`]);
      expect(call[2].windowsVerbatimArguments).toBe(true);
      expect(call[2].env.SystemRoot).toBeTruthy(); expect(call[2].env.TEMP).toBeTruthy();
    } else expect(call[0]).toBe("/bin/sh");
  });
  it("refuses fallback without exact run-bound permission, including an isolation-only grant", async () => {
    platform("win32");
    for (const policy of [undefined, approved(false), { ...approved(), runId: "another-run" }]) {
      await expect(runCommand(root, command, 5000, policy)).rejects.toThrow(/requires approval/);
    }
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(readFileSync(path.join(root, "input.txt"), "utf8")).toBe("ORIGINAL");
  });
  it("falls back when the Linux isolation probe fails before executing user code", async () => {
    platform("linux"); mocks.bwrap.mockReturnValue("/usr/bin/bwrap");
    expect((await getCommandCapability()).status).toBe("approval_required");
    const result = await runCommand(root, command, 5000, approved());
    expect(result.isolationStatus).toBe("unisolated"); expect(result.isolationMessage).toContain("user namespaces disabled");
    expect(mocks.exec.mock.calls.filter(call => call[1].includes(command))).toHaveLength(1);
  });
  it("keeps Linux isolation when its probe passes", async () => {
    platform("linux"); mocks.bwrap.mockReturnValue("/opt/tools/bwrap");
    mocks.exec.mockResolvedValue({ stdout: "WORKBENCH_ISOLATED", stderr: "" });
    expect((await getCommandCapability()).status).toBe("os_isolated");
    const result = await runCommand(root, command, 5000, approved(false));
    expect(result.isolationStatus).toBe("os_isolated"); expect(mocks.exec.mock.calls.at(-1)![0]).toBe("/opt/tools/bwrap");
  });
  it("does not retry user code without isolation after a sandboxed command fails", async () => {
    platform("linux"); mocks.bwrap.mockReturnValue("/usr/bin/bwrap");
    mocks.exec.mockImplementation(async (_binary, args) => {
      if (args.includes("printf WORKBENCH_ISOLATED")) return { stdout: "WORKBENCH_ISOLATED", stderr: "" };
      throw Object.assign(new Error("command failed"), { code: 7 });
    });
    const result = await runCommand(root, command, 5000, approved());
    expect(result.exitCode).toBe(7); expect(result.isolationStatus).toBe("os_isolated");
    expect(mocks.exec).toHaveBeenCalledTimes(2);
  });
  it("reports unavailable only when the native shell cannot start", async () => {
    platform("win32"); mocks.exec.mockRejectedValue(new Error("cmd.exe missing"));
    expect(await getCommandCapability()).toMatchObject({ status: "unavailable", message: expect.stringContaining("cmd.exe missing") });
  });
  it("does not publish fallback changes after approval is revoked", async () => {
    platform("win32"); const policy = approved();
    mocks.exec.mockImplementation(async (_binary, _args, options) => {
      writeFileSync(path.join(options.cwd, "input.txt"), "changed"); policy.guard.revokeRunScopes("run");
      return { stdout: "checked", stderr: "" };
    });
    await expect(runCommand(root, command, 5000, policy)).rejects.toThrow(/revoked/);
    expect(readFileSync(path.join(root, "input.txt"), "utf8")).toBe("ORIGINAL");
  });
});
