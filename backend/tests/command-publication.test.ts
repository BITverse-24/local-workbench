import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureCommandWorkspaceDigest, commandApprovalDigest, runCommand } from '../src/main/harness/tools/run-command.js';
import { runCommandTool } from '../src/main/tools/workspace-tools.js';
import { MutationPolicyGuard } from '../src/main/harness/policy-guard.js';
import { withRuntimeScope } from '../src/main/run/runtime-scope.js';
import { executeProcess } from '../src/main/tools/child-process.js';
import { writeFile } from '../src/main/harness/tools/write-file.js';
import { deleteFile } from '../src/main/harness/tools/delete-file.js';
import { validateAgentDependencyChange } from '../src/main/agent/dependency-constraint.js';

vi.mock('../src/main/tools/child-process.js', () => ({executeProcess: vi.fn()}));

describe('Command publication and approval scopes', () => {
  let root: string, work: string;
  let apply: (cwd: string) => void;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'command-publication-')); work = path.join(root, 'workspace'); mkdirSync(work);
    writeFileSync(path.join(work, 'target.txt'), 'ORIGINAL');
    apply = () => {};
    vi.mocked(executeProcess).mockReset().mockImplementation(async (binary, args, options) => {
      expect(binary).toMatch(/sandbox-exec|bwrap/);
      expect(options.env?.HOME).not.toBe(process.env.HOME);
      expect(options.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      if(args.at(-1) === 'printf WORKBENCH_ISOLATED') return {stdout:'WORKBENCH_ISOLATED',stderr:''};
      apply(options.cwd!);
      return {stdout:'actual fixture output',stderr:''};
    });
  });
  afterEach(() => rmSync(root, {recursive:true,force:true}));
  function boundApproval(command = 'fixture command') {
    const approval = { workspaceDigest: captureCommandWorkspaceDigest(work) };
    const guard = new MutationPolicyGuard({strict:true});
    guard.setEnforceExplicit('run',true);
    guard.grantScope({runId:'run',operation:'run_command',command,operationDigest:commandApprovalDigest(command,approval)});
    return { guard, runId:'run', approval };
  }
  it('passes the revision-bound approval through the workspace tool and preserves backups', async () => {
    const policy = boundApproval();
    apply = cwd => writeFileSync(path.join(cwd,'target.txt'),'NEW');
    const result = await runCommandTool.execute({command:'fixture command'}, {runId:'run',workspaceRoot:work,gateway:{} as any,policyGuard:policy.guard,agentCommandApproval:policy.approval});
    expect(result.sideEffects).toContain('written:target.txt');
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('NEW');
    expect(readdirSync(path.join(work,'.harness_backups'))).toHaveLength(1);
  });
  it('rejects changed inputs before executing the approved command', async () => {
    const policy = boundApproval();
    writeFileSync(path.join(work,'new-input.txt'),'LATER');
    await expect(runCommand(work,'fixture command',5000,policy)).rejects.toThrow(/approval is stale/);
    expect(vi.mocked(executeProcess).mock.calls.every(call => call[1].at(-1)==='printf WORKBENCH_ISOLATED')).toBe(true);
    expect(existsSync(path.join(work,'.harness_backups'))).toBe(false);
  });
  it('checks all command changes against dependency constraints before publishing any file',async()=>{
    const policy=boundApproval();
    const constraints=[{kind:'no_new_dependencies' as const,requirementId:'preserve-deps',source:{messageId:'message',start:0,end:24,quote:'Do not add dependencies.'}}];
    apply=cwd=>{writeFileSync(path.join(cwd,'target.txt'),'NEW');writeFileSync(path.join(cwd,'added.js'),'import x from "new-package";');};
    await expect(runCommandTool.execute({command:'fixture command'},{runId:'run',workspaceRoot:work,gateway:{} as any,policyGuard:policy.guard,agentCommandApproval:policy.approval,agentDependencyConstraints:constraints})).rejects.toThrow(/new external module/);
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('ORIGINAL');expect(existsSync(path.join(work,'added.js'))).toBe(false);
    expect(existsSync(path.join(work,'.harness_backups'))).toBe(false);
  });
  it.each(['modify', 'create', 'delete'])('rejects publication if an unchanged command input changes externally: %s', async operation => {
    const other = path.join(work,'other.txt'); writeFileSync(other,'OTHER');
    const policy = boundApproval();
    apply = cwd => {
      writeFileSync(path.join(cwd,'target.txt'),'NEW');
      if (operation === 'modify') writeFileSync(other,'EXTERNAL');
      if (operation === 'create') writeFileSync(path.join(work,'added.txt'),'EXTERNAL');
      if (operation === 'delete') rmSync(other);
    };
    await expect(runCommand(work,'fixture command',5000,policy)).rejects.toThrow(/Workspace changed/);
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('ORIGINAL');
    expect(existsSync(path.join(work,'.harness_backups'))).toBe(false);
  });
  it('rejects a substituted command or source binding despite a valid command grant', async () => {
    const policy = boundApproval();
    await expect(runCommand(work,'other command',5000,policy)).rejects.toThrow(/revoked/);
    await expect(runCommand(work,'fixture command',5000,{...policy,approval:{workspaceDigest:'0'.repeat(64)}})).rejects.toThrow(/revoked/);
    expect(vi.mocked(executeProcess).mock.calls.every(call => call[1].at(-1)==='printf WORKBENCH_ISOLATED')).toBe(true);
  });
  it('requires revision-bound authority at the v3 command boundary', async () => {
    const guard = new MutationPolicyGuard({strict:true}); guard.grantScope({runId:'run',operation:'run_command',command:'fixture command'});
    await expect(withRuntimeScope({runId:randomUUID(),mode:'agent',agentPhase:'actions',signal:new AbortController().signal},()=>runCommand(work,'fixture command',5000,{guard,runId:'run'}))).rejects.toThrow(/revision-bound approval/);
    expect(executeProcess).not.toHaveBeenCalled();
  });
  it('publishes authorized content edits through backups', async () => {
    const guard = new MutationPolicyGuard({strict:true});
    guard.grantScope({runId:'run',operation:'run_command',command:'fixture command'});
    guard.setMutationTargetRestriction('run',true,['target.txt']);
    apply = cwd => writeFileSync(path.join(cwd,'target.txt'),'NEW');
    const result = await runCommand(work,'fixture command',5000,{guard,runId:'run'});
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('NEW');
    expect(result.changes).toEqual(['written:target.txt']);
    expect(readFileSync(path.join(work,result.backupPaths[0]),'utf8')).toBe('ORIGINAL');
  });
  it('rejects the whole change set when it contains an unapproved target', async () => {
    const guard = new MutationPolicyGuard({strict:true});
    guard.grantScope({runId:'run',operation:'run_command',command:'fixture command'});
    guard.setMutationTargetRestriction('run',true,['target.txt']);
    apply = cwd => {writeFileSync(path.join(cwd,'target.txt'),'NEW');writeFileSync(path.join(cwd,'extra.txt'),'EXTRA');};
    await expect(runCommand(work,'fixture command',5000,{guard,runId:'run'})).rejects.toThrow(/out-of-scope/);
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('ORIGINAL');
    expect(existsSync(path.join(work,'extra.txt'))).toBe(false);
    expect(existsSync(path.join(work,'.harness_backups'))).toBe(false);
  });
  it('preserves originals after a failed command or cancellation', async () => {
    vi.mocked(executeProcess).mockImplementation(async (_binary,args,options) => {
      if(args.at(-1)==='printf WORKBENCH_ISOLATED')return {stdout:'WORKBENCH_ISOLATED',stderr:''};
      writeFileSync(path.join(options.cwd!,'target.txt'),'BROKEN');
      throw Object.assign(new Error('real process failure'),{code:7,stderr:'failure'});
    });
    const failed = await runCommand(work,'fixture command');
    expect(failed.exitCode).toBe(7);expect(failed.changes).toEqual([]);
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('ORIGINAL');
    const controller = new AbortController();
    vi.mocked(executeProcess).mockImplementation(async (_binary,args,options) => {
      if(args.at(-1)==='printf WORKBENCH_ISOLATED')return {stdout:'WORKBENCH_ISOLATED',stderr:''};
      writeFileSync(path.join(options.cwd!,'target.txt'),'CANCELLED');controller.abort();return {stdout:'late',stderr:''};
    });
    await expect(withRuntimeScope({runId:randomUUID(),mode:'agent',signal:controller.signal},()=>runCommand(work,'fixture command'))).rejects.toThrow();
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('ORIGINAL');
  });
  it('does not publish after authority is revoked or originals change', async () => {
    const guard = new MutationPolicyGuard({strict:true});guard.grantScope({runId:'run',operation:'run_command',command:'fixture command'});
    apply = cwd => {writeFileSync(path.join(cwd,'target.txt'),'NEW');guard.revokeRunScopes('run');};
    await expect(runCommand(work,'fixture command',5000,{guard,runId:'run'})).rejects.toThrow(/revoked/);
    apply = cwd => {writeFileSync(path.join(cwd,'target.txt'),'NEW');writeFileSync(path.join(work,'target.txt'),'EXTERNAL');};
    await expect(runCommand(work,'fixture command')).rejects.toThrow(/Workspace changed/);
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('EXTERNAL');
  });
  it('rejects generated symlinks and writes through an input symlink', async () => {
    apply = cwd => symlinkSync(path.join(root,'outside.txt'),path.join(cwd,'generated.txt'));
    await expect(runCommand(work,'fixture command')).rejects.toThrow(/symlinks/);
    symlinkSync('target.txt',path.join(work,'alias.txt'));
    apply = cwd => writeFileSync(path.join(cwd,'alias.txt'),'NEW');
    await expect(runCommand(work,'fixture command')).rejects.toThrow(/symlink input/);
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('ORIGINAL');
  });
  it('rejects wildcard, runner-wide, prefix and altered quoted command grants', () => {
    const guard = new MutationPolicyGuard({strict:true});
    for (const command of ['*','python3 -B check.py',"echo 'two  spaces'"] ) guard.grantScope({runId:'run',operation:'run_command',command});
    for(const command of ["python3 -c 'print(2)'",'python3 -B check.py; echo extra',"echo 'two spaces'"])expect(guard.isAuthorized('run','run_command',{command})).toBe(false);
    expect(guard.isAuthorized('run','run_command',{command:"echo 'two  spaces'"})).toBe(true);
    guard.grantScope({runId:'run',operation:'write_file',targetPath:'first/file.txt'});
    expect(guard.isAuthorized('run','write_file',{path:'first/fixed-file.txt'})).toBe(false);
    guard.setMutationTargetRestriction('run',true,['first/file.txt']);
    expect(guard.isPathTargetRestricted('run','second/file.txt')).toBe(true);
  });
  it('rejects a symlink backup directory before changing any source file', () => {
    const external = path.join(root,'external');mkdirSync(external);symlinkSync(external,path.join(work,'.harness_backups'));
    expect(()=>writeFile(work,'target.txt','NEW')).toThrow(/Backup storage/);
    expect(()=>deleteFile(work,'target.txt')).toThrow(/Backup storage/);
    expect(readFileSync(path.join(work,'target.txt'),'utf8')).toBe('ORIGINAL');
    expect(readdirSync(external)).toEqual([]);
  });
});
