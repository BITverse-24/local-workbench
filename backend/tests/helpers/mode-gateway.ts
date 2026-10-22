import { vi } from 'vitest';
import { testModelGateway } from './test-model-registry.js';

/** Provider responses only. File readers, persistence, policy and subprocesses stay real. */
export function modeGateway(intent: Record<string, unknown>, generate: (messages: any[], tools: any[], options: any) => any) {

  const gateway = testModelGateway();

  const execute = vi.spyOn(gateway, 'execute').mockResolvedValue({ ok: true, value: { result: intent } } as any);

  const turns: any[][] = [];

  const chat = vi.spyOn(gateway, 'chatWithTools').mockImplementation(async (_model, messages, tools, options) => {

    turns.push(messages);

    const schema = options?.responseSchema?.name;

    let value: any;

    if (schema === 'source_agreement') value = {content: JSON.stringify({conflicts:[],unresolved:[]})};
    else if (schema === 'work_requirements') value = { content: '{"checks":[]}' };
    else if (schema === 'work_content_review') {

      const evidence = String(messages[1].content);

      const source = JSON.parse(evidence.split('ORIGINAL SOURCES:\n')[1].split('\nSAVED OUTPUT:\n')[0]);
      const output = JSON.parse(evidence.split('SAVED OUTPUT:\n')[1].split('\nRUNTIME EVIDENCE:\n')[0]);
      value = { content: JSON.stringify({ checks: [{ id: 'content:complete_request', status: 'passed', reason: 'The fixture response meets the requested content.', outputLineNumbers: [output.find((item:any)=>!item.text.startsWith('FILE '))!.line], sourceLineNumbers: source.length?[source[0].line]:[],runtimeLineNumbers:[] }], coverageGaps: [] }) };

    } else value = await generate(messages, tools, options);

    return { ok: true, value: { tool_calls: [], finishReason: 'stop', ...(typeof value === 'string' ? { content: value } : value) } } as any;

  });

  return { gateway, execute, chat, turns };
}

export function fixtureIntent(goal: string, outputs: Array<{ type: string; filename: string }> = [], extra: Record<string, unknown> = {}) {

  return { intentType: outputs.length ? 'document_drafting' : 'general_qa', primaryGoal: goal, driverModel: 'primary-model', taskType: 'draft', isActionable: outputs.length > 0, chatResponseOnly: !outputs.length, workspaceMutationRequested: false, expectedDeliverables: outputs, ...extra };
}
