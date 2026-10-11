import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { runCommand, detectPlatformContainment } from '../../../backend/src/main/harness/tools/run-command.js';
import { runCommandTool } from '../../../backend/src/main/tools/workspace-tools.js';
import { MutationPolicyGuard } from '../../../backend/src/main/harness/policy-guard.js';
import { withRuntimeScope } from '../../../backend/src/main/run/runtime-scope.js';

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'workbench-ship-command-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  writeFileSync(path.join(root, 'outside.txt'), 'before');
  let fallbackApprovals = 0;
  const runId = randomUUID(); const guard = new MutationPolicyGuard();
  const command = `node -e "require('fs').writeFileSync('../outside.txt','after')"`;
  guard.grantScope({runId, operation:'run_command', command});
  const controller = new AbortController();
  const result = await withRuntimeScope({runId, mode:'agent', signal:controller.signal,
    approveUncontainedPython:async()=>{fallbackApprovals++; return false;}}, ()=>
    runCommandTool.execute({command}, {runId, workspaceRoot:workspace, policyGuard:guard, gateway:{} as any}));
  const writeEscaped = readFileSync(path.join(root, 'outside.txt'), 'utf8') === 'after';
  writeFileSync(path.join(root, 'outside.txt'), 'before');
  process.env.WORKBENCH_USE_MAC_SANDBOX = '1';
  const containmentClaimed = detectPlatformContainment();
  const sandboxResult = await runCommand(workspace, command);
  const sandboxFlagEscaped = readFileSync(path.join(root, 'outside.txt'), 'utf8') === 'after';
  delete process.env.WORKBENCH_USE_MAC_SANDBOX;
  writeFileSync(path.join(workspace, 'local-module.py'), 'value = 1\n');
  const echo = 'echo checked'; guard.grantScope({runId, operation:'run_command', command:echo});
  await runCommandTool.execute({command:echo}, {runId, workspaceRoot:workspace, policyGuard:guard, gateway:{} as any});
  const extraAlias = existsSync(path.join(workspace, 'local_module.py'));
  unlinkSync(path.join(workspace, 'local_module.py'));
  const rejectedCommand='curl http://127.0.0.1:1';
  guard.grantScope({runId,operation:'run_command',command:rejectedCommand});
  let unsafeCommandRejected=false;
  try{await runCommandTool.execute({command:rejectedCommand},{runId,workspaceRoot:workspace,policyGuard:guard,gateway:{} as any});}
  catch{unsafeCommandRejected=true;}
  const rejectedCommandCreatedAlias=existsSync(path.join(workspace,'local_module.py'));
  const server = createServer((_req,res)=>res.end('local probe'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port = (server.address() as {port:number}).port;
  const network = await runCommand(workspace, `node -e "require('http').get('http://127.0.0.1:${port}',r=>{r.resume();r.on('end',()=>console.log('CONNECTED'))})"`);
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  const evidence = {root, platform:process.platform, writeEscaped, fallbackApprovals,
    approvedCommandResult:JSON.parse(result.output), containmentClaimed, sandboxFlagEscaped, sandboxResult,
    echoCreatedUnrequestedAlias:extraAlias, aliasIsSymlink:extraAlias&&lstatSync(path.join(workspace,'local_module.py')).isSymbolicLink(),
    unsafeCommandRejected,rejectedCommandCreatedAlias,
    networkBlocked:!network.stdout.includes('CONNECTED'), networkResult:network};
  writeFileSync('/tmp/workbench-ship-command-evidence.json',JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
