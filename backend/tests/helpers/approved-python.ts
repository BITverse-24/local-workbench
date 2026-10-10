import { executePythonTool as original } from '../../src/main/tools/specialist-tools.js';
import { withRuntimeScope } from '../../src/main/run/runtime-scope.js';
import type { AgentTool } from '../../src/main/tools/types.js';
/** These fixtures explicitly approve their known local Python programs. */
export const approvedPythonTool: AgentTool={...original,execute:(args,context)=>withRuntimeScope({runId:context.runId,mode:'agent',signal:context.signal??new AbortController().signal,approveUncontainedPython:async()=>true},()=>original.execute(args,context))};
