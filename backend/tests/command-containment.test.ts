import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { runCommand } from '../src/main/harness/tools/run-command.js';
import { runCommandTool } from '../src/main/tools/workspace-tools.js';
import { MutationPolicyGuard } from '../src/main/harness/policy-guard.js';

// No mocked launcher: test the actual OS boundary or refusal to start.
describe('Actual command containment', () => {
  let root: string, work: string, prior: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'command-boundary-'));
    work = path.join(root, 'workspace'); mkdirSync(work);
    writeFileSync(path.join(root, 'outside.txt'), 'ORIGINAL');
    prior = process.env.WORKBENCH_USE_MAC_SANDBOX;
    process.env.WORKBENCH_USE_MAC_SANDBOX = '1';
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.WORKBENCH_USE_MAC_SANDBOX;
    else process.env.WORKBENCH_USE_MAC_SANDBOX = prior;
    rmSync(root, { recursive: true, force: true });
  });
  async function isolatedOrRefused(command: string) {
    try { return await runCommand(work, command, 5000); }
    catch (error) {
      expect(String(error)).toMatch(/Unsupported sandbox containment|path escapes workspace|snapshots do not accept symlinks|No changes were published/);
      return null;
    }
  }
  it('prevents absolute, traversal and chained interpreter writes even with the macOS flag', async () => {
    for (const target of ['../outside.txt', path.join(root, 'outside.txt')]) {
      const command = `echo probe; python3 -B -c ${JSON.stringify(`open(${JSON.stringify(target)}, 'w').write('ESCAPED')`)}`;
      const result = await isolatedOrRefused(command);
      if (result) expect(result.exitCode).not.toBe(0);
      expect(readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('ORIGINAL');
    }
  });
  it('blocks reading outside user data', async () => {
    const result = await isolatedOrRefused(`cat ${JSON.stringify(path.join(root, 'outside.txt'))}`);
    if (result) { expect(result.exitCode).not.toBe(0); expect(result.stdout).not.toContain('ORIGINAL'); }
  });
  it('blocks network access for interpreted programs', async () => {
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.end('NETWORK'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await isolatedOrRefused(`python3 -B -c ${JSON.stringify(`import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${port}',timeout=1).read())`)}`);
      expect(requests).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('does not expose outside symlinks or shared hard-link writes', async () => {
    symlinkSync(path.join(root, 'outside.txt'), path.join(work, 'link.txt'));
    await isolatedOrRefused('echo changed > link.txt');
    expect(readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('ORIGINAL');
    rmSync(path.join(work, 'link.txt'));
    linkSync(path.join(root, 'outside.txt'), path.join(work, 'linked.txt'));
    await isolatedOrRefused('echo changed > linked.txt');
    expect(readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('ORIGINAL'); // atomic writer replaces the inode
  });
  it('makes no alias files for either an accepted or rejected command', async () => {
    writeFileSync(path.join(work, 'local-module.py'), 'value = 1');
    await isolatedOrRefused('echo checked');
    const guard = new MutationPolicyGuard({strict: true});
    const command = 'curl http://127.0.0.1:1';
    guard.grantScope({runId:'run', operation:'run_command', command});
    await expect(runCommandTool.execute({command}, {runId:'run',workspaceRoot:work,gateway:{} as any,policyGuard:guard})).rejects.toThrow(/unsafe/);
    expect(existsSync(path.join(work, 'local_module.py'))).toBe(false);
  });
  it('fails closed when isolation is disabled', async () => {
    if (process.platform !== 'darwin') return;
    process.env.WORKBENCH_USE_MAC_SANDBOX = '0';
    await expect(runCommand(work, 'echo forbidden > created.txt')).rejects.toThrow(/Unsupported sandbox containment/);
    expect(existsSync(path.join(work, 'created.txt'))).toBe(false);
  });
});
