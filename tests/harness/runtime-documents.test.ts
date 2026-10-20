import { afterEach, describe, expect, it } from "vitest";
import { existsSync, realpathSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { Document, Packer, Paragraph } from "docx";
import { createSandbox, destroySandbox, macProfile, runtimeReadPaths, spawnContained, type Sandbox } from "./sandbox.js";
import { terminateTree } from "./watchdog.js";

const boxes: Sandbox[] = [], outside: string[] = [];
afterEach(() => { boxes.splice(0).forEach(destroySandbox); outside.splice(0).forEach(file => rmSync(file, { force: true })); });
describe.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))("contained document runtime", () => {
  it("parses a real Word file while sibling host data stays denied", async () => {
    const root = process.cwd(), box = createSandbox(path.join(root, "tests/.runtime/documents")); boxes.push(box);
    const protectedFile = path.join(path.dirname(box.root), `${path.basename(box.root)}-private.txt`); outside.push(protectedFile);
    writeFileSync(protectedFile, "OUTSIDE_DATA");
    const file = path.join(box.workspace, "report.docx");
    writeFileSync(file, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("Measured pressure: 12.7 bar")] }] })));
    const bundle = path.join(box.root, "config", "reader.cjs");
    buildSync({ stdin: { contents: `import {parseFileIndependently} from ${JSON.stringify(path.join(root, "backend/src/main/tools/file-worker.ts"))};
      import fs from 'node:fs';import assert from 'node:assert/strict';
      (async()=>{assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "package.json"))},'utf8')).name,'local-workbench');
      assert.throws(()=>fs.readFileSync(${JSON.stringify(protectedFile)}));
      const parsed=await parseFileIndependently(${JSON.stringify(file)},'docx');assert.match(parsed.text,/12[.]7 bar/);process.stdout.write(JSON.stringify({parsed:true,hostReadDenied:true})+'\\n');})().catch(error=>{console.error(error);process.exitCode=1;});`, resolveDir: root }, outfile: bundle, bundle: true, platform: "node", target: "node20", format: "cjs", packages: "external", logLevel: "silent", define: { "import.meta.url": "undefined" } });
    const reads = [path.join(root, "node_modules"), bundle, ...runtimeReadPaths(root)];
    const profile = macProfile(box, reads);
    expect(profile).toContain(`(literal ${JSON.stringify(path.join(root, "package.json"))})`);
    expect(profile).not.toContain(`(subpath ${JSON.stringify(root)})`);
    const executable = realpathSync(path.join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"));
    const child = spawnContained(box, profile, executable, [bundle]);
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { terminateTree(child); reject(new Error(`Document worker timeout: ${stderr}`)); }, 15000);
        child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ parsed: true, hostReadDenied: true });
      expect(readFileSync(protectedFile, "utf8")).toBe("OUTSIDE_DATA");
    } finally { terminateTree(child); }
  });
});
