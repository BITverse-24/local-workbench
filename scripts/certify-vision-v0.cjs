/** Visual capability smoke tests. Synthetic evidence stays in the test harness. */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildSync } = require("esbuild");
const { createCanvas } = require("canvas");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "tests/.runtime/vision-v0", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(output, { recursive: true });

const canvas = createCanvas(600, 400);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "white";
ctx.fillRect(0, 0, 600, 400);
ctx.fillStyle = "#1764db";
for (const x of [120, 290]) {
  ctx.beginPath(); ctx.arc(x, 160, 65, 0, Math.PI * 2); ctx.fill();
}
ctx.fillStyle = "#d92d2d";
ctx.beginPath(); ctx.moveTo(450, 90); ctx.lineTo(520, 230); ctx.lineTo(380, 230); ctx.closePath(); ctx.fill();
fs.writeFileSync(path.join(output, "shapes.png"), canvas.toBuffer("image/png"));

// Embed only an image XObject: there is no PDF text layer to extract.
const jpeg = canvas.toBuffer("image/jpeg");
const commands = Buffer.from("q 600 0 0 400 0 0 cm /Img Do Q\n");
const objects = [
  Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
  Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
  Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /XObject << /Img 5 0 R >> >> /Contents 4 0 R >>"),
  Buffer.concat([Buffer.from(`<< /Length ${commands.length} >>\nstream\n`), commands, Buffer.from("endstream")]),
  Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 600 /Height 400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]),
];
const parts = [Buffer.from("%PDF-1.4\n")];
const offsets = [0];
let position = parts[0].length;
for (let i = 0; i < objects.length; i++) {
  offsets.push(position);
  const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), objects[i], Buffer.from("\nendobj\n")]);
  parts.push(part); position += part.length;
}
parts.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF\n`));
fs.writeFileSync(path.join(output, "image-only.pdf"), Buffer.concat(parts));
fs.writeFileSync(path.join(output, "geometry.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect width="600" height="400" fill="white"/><path d="M180 110 H390 M180 290 H390" stroke="black" stroke-width="6"/><circle cx="120" cy="110" r="60" fill="#1764db"/><circle cx="120" cy="290" r="60" fill="#1764db"/><rect x="390" y="55" width="160" height="290" fill="#23a24d"/></svg>');

const bundle = path.join(output, "smoke.cjs");
buildSync({
  stdin: { resolveDir: root, sourcefile: "vision-smoke.ts", contents: `
    import { randomUUID } from 'node:crypto';
    import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
    import path from 'node:path';
    import { ModelGateway } from './backend/src/main/gateway/model-gateway.ts';
    import { extractDocumentTool } from './backend/src/main/tools/specialist-tools.ts';
    import { createRunDirectories, resolveRunPath, setDataDir } from './backend/src/main/run/filesystem.ts';
    const output = process.argv[2];
    setDataDir(path.join(output, 'data'));
    const registry = JSON.parse(readFileSync(path.join(process.cwd(), 'config/models.json'), 'utf8')).models;
    const gateway = new ModelGateway(undefined, registry);
    const calls = [];
    gateway.onDelegatedInvocation(event => calls.push(event));
    const results = [];
    (async () => {
      for (const filename of ['image-only.pdf', 'shapes.png', 'geometry.svg']) {
        const runId = randomUUID(); createRunDirectories(runId);
        copyFileSync(path.join(output, filename), resolveRunPath(runId, 'input/' + filename, 'input'));
        const before = calls.length; const start = performance.now();
        let result;
        try {
          const observation = await extractDocumentTool.execute({ filename, query: 'Describe the visible shapes, their colors, counts and spatial relationships. Report only what the image shows.' },
            { runId, gateway, currentCallId: randomUUID(), workspaceRoot: resolveRunPath(runId, 'input', 'input') });
          const payload = JSON.parse(observation.output);
          const actualCalls = calls.slice(before);
          const text = JSON.stringify(payload);
          const meaningful = /blue/i.test(text) && /circle/i.test(text) && (filename === 'geometry.svg' ? /green/i.test(text) && /rectang/i.test(text) : /red/i.test(text) && /triang/i.test(text));
          result = { filename, runId, classification: actualCalls.some(call => call.taskType === 'vision') && meaningful ? 'PASS' : 'FAIL', latencySec: (performance.now() - start) / 1000,
            toolPath: ['extract_document', 'ModelGateway.execute(vision)'], calls: actualCalls, payload, manualReviewRequired: true };
        } catch (error) {
          result = { filename, runId, classification: 'FAIL', latencySec: (performance.now() - start) / 1000, error: String(error), calls: calls.slice(before), manualReviewRequired: true };
        }
        results.push(result); writeFileSync(path.join(output, 'results.json'), JSON.stringify({ results, manualReviewRequired: true }, null, 2));
        console.log(filename + ': ' + result.classification + '; ' + result.latencySec.toFixed(1) + 's');
      }
      process.exitCode = results.every(result => result.classification === 'PASS') ? 0 : 1;
    })().catch(error => { console.error(error); process.exitCode = 2; });
  ` },
  outfile: bundle, bundle: true, platform: "node", target: "node20", format: "cjs", packages: "external", logLevel: "error", define: { "import.meta.url": "undefined" },
});
const result = spawnSync(require("electron"), [bundle, output], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" });
console.log(`Visual smoke evidence: ${output}`);
process.exitCode = result.status ?? 2;
