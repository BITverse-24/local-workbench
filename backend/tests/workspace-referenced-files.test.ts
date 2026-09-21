import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { findReferencedWorkspaceFiles } from "../src/main/run/manager.js";
import type { DirEntry } from "../src/main/harness/tools/list-dir.js";

describe("findReferencedWorkspaceFiles", () => {
  it("extracts and loads referenced files using @path and filenames", () => {
    const tmpDir = path.join(process.cwd(), "data", "test-ref-ws-" + Date.now());
    const middlewareDir = path.join(tmpDir, "middleware");
    fs.mkdirSync(middlewareDir, { recursive: true });

    const rateLimiterContent = "const rateLimit = {}; module.exports = rateLimit;";
    const appContent = "const express = require('express'); const app = express();";
    fs.writeFileSync(path.join(middlewareDir, "rateLimiter.js"), rateLimiterContent, "utf8");
    fs.writeFileSync(path.join(tmpDir, "app.js"), appContent, "utf8");

    const tree: DirEntry[] = [
      { name: "middleware/rateLimiter.js", type: "file", size: rateLimiterContent.length },
      { name: "app.js", type: "file", size: appContent.length },
      { name: "package.json", type: "file", size: 100 },
    ];

    try {
      // 1. Mentions @middleware/rateLimiter.js
      const res1 = findReferencedWorkspaceFiles(
        "Make @middleware/rateLimiter.js variable time window based",
        [],
        tmpDir,
        tree,
      );
      expect(res1).toHaveLength(1);
      expect(res1[0].path).toBe("middleware/rateLimiter.js");
      expect(res1[0].content).toBe(rateLimiterContent);

      // 2. Mentions rateLimiter.js by basename
      const res2 = findReferencedWorkspaceFiles(
        "I think rateLimiter.js still uses a fixed 15 min window",
        [],
        tmpDir,
        tree,
      );
      expect(res2).toHaveLength(1);
      expect(res2[0].path).toBe("middleware/rateLimiter.js");

      // 3. Mentions in recent chat history
      const history = [
        { role: "user", content: "Can you inspect app.js?" },
        { role: "assistant", content: "Sure, let me check." },
      ];
      const res3 = findReferencedWorkspaceFiles(
        "Also check the rateLimiter.js",
        history,
        tmpDir,
        tree,
      );
      const paths = res3.map((r) => r.path);
      expect(paths).toContain("app.js");
      expect(paths).toContain("middleware/rateLimiter.js");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
