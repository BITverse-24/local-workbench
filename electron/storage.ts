import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RuntimeMode = "development" | "preview" | "production";

export function resolveRuntimeMode(isPackaged: boolean, env: NodeJS.ProcessEnv): RuntimeMode {
  if (isPackaged) return "production";
  return env.NODE_ENV === "production" || env.WORKBENCH_PROD ? "preview" : "development";
}

export function resolveStoragePaths(options: {
  mode: RuntimeMode;
  appDataPath: string;
  repoRoot: string;
  resourcesPath: string;
  env: NodeJS.ProcessEnv;
}) {
  const { mode, appDataPath, repoRoot, resourcesPath, env } = options;
  // Set both Electron paths before readiness: Chromium can otherwise open the
  // default shared profile before the backend starts.
  const userDataPath = path.join(appDataPath, "local-workbench", mode);
  // Keep existing development fixtures and CLI data in the repository. Preview
  // and release must never restore them or the old shared Electron profile.
  const dataDir = mode === "development"
    ? path.join(repoRoot, "data")
    : path.join(userDataPath, "data");
  const modelsPath = mode === "development"
    ? env.WORKBENCH_MODELS_PATH ?? path.join(repoRoot, "config", "models.json")
    : path.join(dataDir, "models.json");
  const schemaPath = mode === "production"
    ? path.join(resourcesPath, "backend", "schema.sql")
    : path.join(repoRoot, "backend", "src", "main", "persistence", "schema.sql");
  return { userDataPath, dataDir, modelsPath, schemaPath };
}

export function initializeModelRegistry(mode: RuntimeMode, modelsPath: string): void {
  if (mode === "development") return;
  mkdirSync(path.dirname(modelsPath), { recursive: true });
  try {
    // A release ships no model profiles. Preserve configuration saved by this
    // environment on subsequent starts, including concurrent starts.
    writeFileSync(modelsPath, JSON.stringify({ models: [] }, null, 2), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
