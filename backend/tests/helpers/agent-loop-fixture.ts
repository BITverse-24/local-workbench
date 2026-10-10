import { AgentLoop as OriginalAgentLoop } from '../../src/main/agent/agent-loop.js';
import { buildExecutionEnvelope } from '../../src/main/run/envelope.js';
/** Unit fixtures call the Agent engine explicitly. Backend mode selection is tested separately. */
export class AgentLoop extends OriginalAgentLoop {
  override run(options:Parameters<OriginalAgentLoop['run']>[0]):ReturnType<OriginalAgentLoop['run']> {
    const envelope=options.envelope??buildExecutionEnvelope({runId:options.runId,mode:'agent',modelId:options.driverModelId,hasWorkspace:true,workspaceRoot:options.context.workspaceRoot,computationRequested:options.tools.some(tool=>tool.name==='execute_python'),deliverableRequested:options.tools.some(tool=>tool.name==='generate_deliverable'),mutationRequested:options.tools.some(tool=>['write_file','delete_file'].includes(tool.name)),commandExecutionRequested:options.tools.some(tool=>tool.name==='run_command')});
    // Unit callers approve operations explicitly. Production approval is covered by manager tests.
    return super.run({...options,envelope,onPlanConfirmationRequired:options.onPlanConfirmationRequired??(async()=>true),context:{...options.context,envelope}});
  }
}
