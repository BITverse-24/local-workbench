import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

const require = createRequire(import.meta.url);
const { resetDevDefaults, appDataPath } = require("../../scripts/reset-dev-defaults.cjs");
const roots: string[] = [];
const schema = readFileSync(path.resolve("backend/src/main/persistence/schema.sql"), "utf8");

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "workbench-package-reset-"));
  roots.push(root);
  return { repoRoot: path.join(root, "repo"), appData: path.join(root, "profiles") };
}

function write(filename: string, text: string) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, text);
}

function seedDatabase(filename: string) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.exec(schema);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO chats(id, title, created_at, updated_at) VALUES ('saved-chat', 'Keep this chat', ?, ?)").run(now, now);
  const setting = db.prepare("INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)");
  for (const [key, value] of Object.entries({
    configured_models: [{ modelName: "development-model" }],
    embedding_config: { model: "development-embedding" },
    onboarding_completed: true,
    selectedModel: "development-model",
    temperature: 0.8,
    active_workspace_root: "/old/workspace",
  })) setting.run(key, JSON.stringify(value), now);
  db.close();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("package development defaults reset", () => {
  it("clears both development databases and browser defaults, preserving chats and release data", () => {
    const options = fixture();
    const devDatabases = ["data/workbench.db", "data/data/workbench.db"].map(relative => path.join(options.repoRoot, relative));
    for (const filename of devDatabases) seedDatabase(filename);
    write(path.join(options.repoRoot, "config/models.json"), '{"models":[{"model":"dev"}]}');
    write(path.join(options.repoRoot, "data/models.json"), '{"models":[{"model":"dev-backup"}]}');
    const runFile = path.join(options.repoRoot, "data/runs/saved/output/report.txt");
    const knowledgeFile = path.join(options.repoRoot, "data/rag/index.json");
    write(runFile, "saved result");
    write(knowledgeFile, "saved knowledge");
    const profile = path.join(options.appData, "local-workbench/development");
    write(path.join(profile, "Local Storage/leveldb/saved"), "selected model");
    write(path.join(profile, "Session Storage/saved"), "saved session");
    const releaseFiles: string[] = [];
    for (const mode of ["preview", "production"]) {
      const base = path.join(options.appData, "local-workbench", mode);
      const dbPath = path.join(base, "data/data/workbench.db");
      seedDatabase(dbPath);
      releaseFiles.push(dbPath);
      for (const relative of ["data/models.json", "Local Storage/leveldb/saved"]) {
        const filename = path.join(base, relative);
        write(filename, `${mode} model settings`);
        releaseFiles.push(filename);
      }
    }
    const before = releaseFiles.map(filename => readFileSync(filename));

    expect(resetDevDefaults(options).settingsDeleted).toBe(12);
    expect(resetDevDefaults(options).settingsDeleted).toBe(0);
    for (const filename of devDatabases) {
      const db = new Database(filename, { readonly: true });
      try {
        expect(db.prepare("SELECT * FROM settings").all()).toEqual([]);
        expect(db.prepare("SELECT title FROM chats").get()).toEqual({ title: "Keep this chat" });
      } finally { db.close(); }
    }
    expect(JSON.parse(readFileSync(path.join(options.repoRoot, "config/models.json"), "utf8"))).toEqual({ models: [] });
    expect(existsSync(path.join(options.repoRoot, "data/models.json"))).toBe(false);
    expect(existsSync(path.join(profile, "Local Storage"))).toBe(false);
    expect(existsSync(path.join(profile, "Session Storage"))).toBe(false);
    expect(readFileSync(runFile, "utf8")).toBe("saved result");
    expect(readFileSync(knowledgeFile, "utf8")).toBe("saved knowledge");
    releaseFiles.forEach((filename, index) => expect(readFileSync(filename)).toEqual(before[index]));
  });

  it("handles a fresh checkout and runs before both package commands", () => {
    const options = fixture();
    expect(resetDevDefaults(options).settingsDeleted).toBe(0);
    expect(existsSync(path.join(options.repoRoot, "data/workbench.db"))).toBe(false);
    const { scripts } = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
    expect(scripts.prepackage).toBe("node scripts/reset-dev-defaults.cjs");
    expect(scripts["prepackage:dir"]).toBe(scripts.prepackage);
    expect(appDataPath("darwin", {}, "/user")).toBe("/user/Library/Application Support");
    expect(appDataPath("win32", { APPDATA: "/roaming" }, "/user")).toBe("/roaming");
    expect(appDataPath("linux", { XDG_CONFIG_HOME: "/config" }, "/user")).toBe("/config");
  });

  it.skipIf(process.platform === "win32")("rejects a running development profile before changing defaults", () => {
    const options = fixture();
    const profile = path.join(options.appData, "local-workbench/development");
    mkdirSync(profile, { recursive: true });
    symlinkSync(`${os.hostname()}-${process.pid}`, path.join(profile, "SingletonLock"));
    const registry = path.join(options.repoRoot, "config/models.json");
    write(registry, "keep configuration");
    expect(() => resetDevDefaults(options)).toThrow("Close the development app before packaging");
    expect(readFileSync(registry, "utf8")).toBe("keep configuration");
  });
});
