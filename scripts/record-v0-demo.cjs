/** Record real CLI output and timing. No result substitution or replay input. */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const taskIds = process.argv.length > 2 ? process.argv.slice(2) : ["document-normal", "code-normal", "inspection-normal"];
const directory = path.join(root, "tests/.runtime/v0-recordings", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(directory, { recursive: true });
const recording = fs.createWriteStream(path.join(directory, "normal-abc.cast"));
const transcript = fs.createWriteStream(path.join(directory, "normal-abc.log"));
recording.write(JSON.stringify({ version: 2, width: 140, height: 42, timestamp: Math.floor(Date.now() / 1000), title: "Local Workbench — genuine CLI task runs", env: { TERM: "xterm-256color", SHELL: process.env.SHELL ?? "" } }) + "\n");
const start = performance.now();
const child = spawn(process.execPath, [path.join(root, "scripts/certify-v0.cjs"), ...taskIds], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
const capture = (chunk, stream) => {
  const text = chunk.toString();
  transcript.write(text);
  recording.write(JSON.stringify([(performance.now() - start) / 1000, "o", text.replace(/\r?\n/g, "\r\n")]) + "\n");
  stream.write(chunk);
};
child.stdout.on("data", chunk => capture(chunk, process.stdout));
child.stderr.on("data", chunk => capture(chunk, process.stderr));
child.on("error", error => { console.error(error); process.exitCode = 2; });
child.on("close", code => {
  recording.end(); transcript.end();
  fs.writeFileSync(path.join(directory, "recording.json"), JSON.stringify({ createdAt: new Date().toISOString(), command: "node scripts/certify-v0.cjs " + taskIds.join(" "), exitCode: code, elapsedSec: (performance.now() - start) / 1000, kind: "live CLI output capture; no GUI video" }, null, 2));
  console.log(`CLI recording: ${directory}`);
  process.exitCode = code ?? 2;
});
