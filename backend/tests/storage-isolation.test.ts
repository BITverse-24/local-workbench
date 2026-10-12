import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSON5 from "json5";
import { initializeModelRegistry, resolveRuntimeMode, resolveStoragePaths } from "../../electron/storage.js";
import { closeDb, configurePersistence, initDb, resolveDbPath } from "../src/main/persistence/db.js";
import { createChat, listChats } from "../src/main/persistence/chats.js";
import { getSetting, setSetting } from "../src/main/persistence/settings-store.js";
import { configureModels, loadProductionRegistryFromDb } from "../src/main/gateway/registry.js";
import { dataRoot, setDataDir, writeRunFile } from "../src/main/run/filesystem.js";

let root: string;
const schemaPath = path.resolve("backend/src/main/persistence/schema.sql");
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "workbench-storage-")); });
afterEach(() => {
  closeDb();
  configureModels({ modelsPath: null });
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function storage(mode: "development" | "preview" | "production") {
  return resolveStoragePaths({ mode, repoRoot: path.join(root, "repo"), appDataPath: root, resourcesPath: path.join(root, "resources"), env: process.env });
}

describe("Desktop environment storage", () => {
  it("always treats a packaged app as production, even with development launch flags", () => {
    expect(resolveRuntimeMode(true, { NODE_ENV: "development", WORKBENCH_PROD: "" })).toBe("production");
    expect(resolveRuntimeMode(false, {})).toBe("development");
    expect(resolveRuntimeMode(false, { NODE_ENV: "production" })).toBe("preview");
    expect(resolveRuntimeMode(false, { WORKBENCH_PROD: "1" })).toBe("preview");
  });

  it("isolates backend files and browser profiles across all three modes", () => {
    const modes = [storage("development"), storage("preview"), storage("production")];
    expect(new Set(modes.map(p => p.dataDir)).size).toBe(3);
    expect(new Set(modes.map(p => p.userDataPath)).size).toBe(3);
    expect(new Set(modes.map(p => p.modelsPath)).size).toBe(3);
    expect(modes[0].dataDir).toBe(path.join(root, "repo", "data"));
    expect(modes[2].schemaPath).toBe(path.join(root, "resources", "backend", "schema.sql"));
  });

  it("ignores development model overrides in preview and production and preserves saved release models", () => {
    const devModels = path.join(root, "dev-models.json");
    writeFileSync(devModels, JSON.stringify({ models: [{ model: "development-only" }] }));
    vi.stubEnv("WORKBENCH_MODELS_PATH", devModels);
    expect(storage("development").modelsPath).toBe(devModels);
    for (const mode of ["preview", "production"] as const) {
      const paths = storage(mode);
      initializeModelRegistry(mode, paths.modelsPath);
      expect(JSON.parse(readFileSync(paths.modelsPath, "utf8"))).toEqual({ models: [] });
      writeFileSync(paths.modelsPath, JSON.stringify({ models: [{ model: `${mode}-saved` }] }));
      initializeModelRegistry(mode, paths.modelsPath);
      expect(JSON.parse(readFileSync(paths.modelsPath, "utf8")).models[0].model).toBe(`${mode}-saved`);
    }
    expect(JSON.parse(readFileSync(devModels, "utf8")).models[0].model).toBe("development-only");
  });

  it("does not restore development chats, settings, run files, or model profiles in preview or production", () => {
    const dev = storage("development");
    configurePersistence({ dataDir: dev.dataDir, schemaPath });
    const devDbPath = resolveDbPath();
    initDb();
    const chat = createChat("Development chat");
    setSetting("onboarding_completed", true);
    setSetting("configured_models", [{ role: "draft", host: "127.0.0.1", port: 1234, modelName: "dev-only", contextLength: 8192 }]);
    setSetting("lastChatId", chat);
    setDataDir(dev.dataDir);
    const runId = "11111111-1111-4111-8111-111111111111";
    const relativeFile = writeRunFile(runId, "output", "development.txt", "development result");
    closeDb();
    // Simulate launching a release from a developer terminal.
    vi.stubEnv("WORKBENCH_DB_PATH", devDbPath);
    vi.stubEnv("WORKBENCH_DATA_ROOT", dev.dataDir);
    vi.stubEnv("WORKBENCH_MODELS_PATH", dev.modelsPath);

    for (const mode of ["preview", "production"] as const) {
      const paths = storage(mode);
      initializeModelRegistry(mode, paths.modelsPath);
      configureModels({ modelsPath: paths.modelsPath });
      configurePersistence({ dataDir: paths.dataDir, schemaPath });
      setDataDir(paths.dataDir);
      expect(resolveDbPath()).not.toBe(devDbPath);
      initDb();
      expect(listChats()).toEqual([]);
      expect(getSetting("configured_models")).toBeUndefined();
      expect(getSetting("onboarding_completed")).toBeUndefined();
      expect(getSetting("lastChatId")).toBeNull();
      expect(loadProductionRegistryFromDb().size).toBe(0);
      expect(dataRoot()).toBe(paths.dataDir);
      expect(() => readFileSync(path.join(dataRoot(), relativeFile))).toThrow();
      const savedChat = createChat(`${mode} chat`);
      closeDb();
      initDb();
      expect(listChats().map(c => c.id)).toEqual([savedChat]);
      closeDb();
    }

    configurePersistence({ dataDir: dev.dataDir, schemaPath });
    initDb();
    expect(listChats().map(c => c.id)).toEqual([chat]);
    expect(getSetting("onboarding_completed")).toBe(true);
    expect(readFileSync(path.join(dev.dataDir, relativeFile), "utf8")).toBe("development result");
  });

  it("excludes the mutable development model registry from release files and resources", () => {
    const config = JSON5.parse(readFileSync("electron/electron-builder.json5", "utf8"));
    expect(config.files).not.toContain("config/models.json");
    expect(config.extraResources.some((resource: { from: string }) => resource.from === "config/models.json")).toBe(false);
  });
});
