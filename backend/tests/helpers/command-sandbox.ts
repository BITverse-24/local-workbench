import type { executeProcess } from '../../src/main/tools/child-process.js';

/** Unit-test transport adapter only. Keeps real fixture commands and assertions,
 * but simulates the sandbox launcher. Real containment is tested separately in
 * command-containment.test.ts without this adapter. Never imported by runtime. */
export function simulateCommandSandbox(actual: typeof executeProcess): typeof executeProcess {
  return (binary, args, options) => {
    if ((binary.endsWith('/sandbox-exec') || binary.endsWith('/bwrap')) && args.at(-3) === '/bin/sh' && args.at(-2) === '-c') {
      return actual('/bin/sh', ['-c', args.at(-1)!], options);
    }
    return actual(binary, args, options);
  };
}
