import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  getPathForFile: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke },
  webUtils: { getPathForFile: mocks.getPathForFile },
}));

await import("../../electron/preload.js");
const workbench = mocks.exposeInMainWorld.mock.calls.find(([name]) => name === "workbench")![1];
const metadata = { doc_id: "maintenance-procedure", title: "Maintenance procedure" };

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.getPathForFile.mockReset();
});

describe("knowledge file selection bridge", () => {
  it("sends the full selected disk path when File.path is absent", async () => {
    const selectedFile = { name: "maintenance-procedure.md" };
    const selectedPath = "/demo/flow_a/scenario-2/maintenance-procedure.md";
    mocks.getPathForFile.mockReturnValue(selectedPath);
    mocks.invoke.mockResolvedValue({ ok: true, docId: metadata.doc_id, chunkCount: 3 });

    await expect(workbench.kbIngestFile(selectedFile, metadata)).resolves.toEqual({
      ok: true, docId: metadata.doc_id, chunkCount: 3,
    });
    expect(mocks.getPathForFile).toHaveBeenCalledWith(selectedFile);
    expect(mocks.invoke).toHaveBeenCalledWith("kb:ingestDoc", { ...metadata, source_path: selectedPath });
  });

  it("rejects a file with no disk path before ingestion, without a filename fallback", () => {
    mocks.getPathForFile.mockReturnValue("");
    expect(() => workbench.kbIngestFile({ name: "maintenance-procedure.md" }, metadata))
      .toThrow("Select a file saved on your computer");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
