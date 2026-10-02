import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { createSandbox, macProfile, spawnContained, destroySandbox } from "./sandbox.js";
import { terminateTree } from "./watchdog.js";

export async function verifyIsolation(runtimeRoot: string): Promise<{ pass: boolean; checks: Record<string, boolean> }> {
  const parent = path.join(runtimeRoot, "tests/.runtime/isolation");
  const box = createSandbox(parent);
  const protectedFile = path.join(parent, `protected-${path.basename(box.root)}.txt`);
  writeFileSync(protectedFile, "PROBE_HOST_DATA");
  const forbiddenWrite = `${protectedFile}.write`;
  const marker = path.join(box.tmp, "surviving-child.txt");
  const detachedMarker = path.join(box.tmp, "surviving-detached-child.txt");
  const electron = realpathSync(path.join(runtimeRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"));
  const server = createServer((_req, res) => res.end("probe"));
  const allowedServer = createServer((_req, res) => res.end("allowed-relay"));
  await Promise.all([server, allowedServer].map((s) => new Promise<void>((r, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", r); })));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Probe listener unavailable");
  const allowedAddress = allowedServer.address();
  if (!allowedAddress || typeof allowedAddress === "string") throw new Error("Allowed probe listener unavailable");
  const profile = macProfile(box, [path.join(runtimeRoot, "node_modules")], allowedAddress.port);
  const code = `const fs=require('fs'); const cp=require('child_process');
    const checks={};
    try { fs.readFileSync(${JSON.stringify(protectedFile)}); checks.hostReadDenied=false; } catch { checks.hostReadDenied=true; }
    try { checks.syntheticCanaryAccessible=fs.readFileSync(${JSON.stringify(path.join(box.canary, "secret.txt"))},'utf8').startsWith('CANARY_'); } catch { checks.syntheticCanaryAccessible=false; }
    try { fs.writeFileSync(${JSON.stringify(forbiddenWrite)},'escape'); checks.hostWriteDenied=false; } catch { checks.hostWriteDenied=true; }
    const inherited=cp.spawnSync(${JSON.stringify(electron)},['-e','try { require("fs").readFileSync('+${JSON.stringify(JSON.stringify(protectedFile))}+'); process.exit(3); } catch { process.exit(0); }']);
    checks.subprocessReadDenied=inherited.status===0;
    fs.writeFileSync(${JSON.stringify(path.join(box.tmp, "allowed.txt"))},'allowed'); checks.scenarioWriteAllowed=true;
    Promise.all([
      fetch('http://127.0.0.1:${address.port}',{signal:AbortSignal.timeout(2000)}).then(()=>checks.networkDenied=false,()=>checks.networkDenied=true),
      fetch('http://127.0.0.1:${allowedAddress.port}',{signal:AbortSignal.timeout(2000)}).then(async r=>checks.relayAllowed=(await r.text())==='allowed-relay',()=>checks.relayAllowed=false)
    ]).then(()=>{
      const descendant=cp.spawn(${JSON.stringify(electron)},['-e','setTimeout(()=>require("fs").writeFileSync('+${JSON.stringify(JSON.stringify(marker))}+',"survived"),1800); setInterval(()=>{},1000)'],{stdio:'ignore'});
      cp.spawn(${JSON.stringify(electron)},['-e','setTimeout(()=>require("fs").writeFileSync('+${JSON.stringify(JSON.stringify(detachedMarker))}+',"survived"),1800); setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
      process.stdout.write(JSON.stringify({...checks,descendant:descendant.pid})+'\\n'); setInterval(()=>{},1000);
    });`;
  const child = spawnContained(box, profile, electron, ["-e", code]);
  try {
    const checks = await new Promise<Record<string, boolean>>((resolve, reject) => {
      let out = "", err = "";
      const timer = setTimeout(() => { terminateTree(child); reject(new Error(`Isolation probe timeout: ${err}`)); }, 10000);
      child.stdout.on("data", (b: Buffer) => { out += b; if (out.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(out.trim())); } catch (e) { reject(e); } } });
      child.stderr.on("data", (b: Buffer) => { err = (err + b).slice(-3000); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("exit", (code, signal) => { if (!out) { clearTimeout(timer); reject(new Error(`Isolation probe exited ${code ?? signal}: ${err}`)); } });
    });
    terminateTree(child);
    await new Promise((r) => setTimeout(r, 2200));
    checks.descendantCleanup = !existsSync(marker);
    checks.detachedDescendantCleanup = !existsSync(detachedMarker);
    delete checks.descendant;
    return { pass: Object.values(checks).every((v) => v === true), checks };
  } finally { terminateTree(child); for (const s of [server, allowedServer]) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); } rmSync(protectedFile, { force: true }); rmSync(forbiddenWrite, { force: true }); destroySandbox(box); }
}
