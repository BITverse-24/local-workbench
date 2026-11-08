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
      const reqMatch = evidence.match(/REQUIREMENTS:\s*(\[.*?\])\s*\nORIGINAL SOURCES:/s);
      let criteriaIds = ['content:complete_request'];
      if (reqMatch) {
        try {
          const reqs = JSON.parse(reqMatch[1]);
          if (Array.isArray(reqs) && reqs.length) {
            criteriaIds = reqs.map((r: any) => r.criterionId);
          }
        } catch {}
      }

      const outputSection = evidence.split('SAVED OUTPUT:\n')[1]?.split('\nRUNTIME EVIDENCE:\n')[0] ?? '';
      const outputMatches = [...outputSection.matchAll(/^(\d+):\s*(.*)$/gm)];
      const nonFileMatch = outputMatches.find(m => !m[2].startsWith('FILE ')) ?? outputMatches[0];
      const outputLine = nonFileMatch ? parseInt(nonFileMatch[1], 10) : 1;

      const sourceSection = evidence.split('ORIGINAL SOURCES:\n')[1]?.split('\nSAVED OUTPUT:\n')[0] ?? '';
      const sourceMatches = [...sourceSection.matchAll(/^(\d+):\s*(.*)$/gm)];
      const sourceLine = sourceMatches.length > 0 ? parseInt(sourceMatches[0][1], 10) : 1;

      value = {
        content: JSON.stringify({
          checks: criteriaIds.map(id => ({
            id,
            status: 'passed',
            reason: 'The fixture response meets the requested content.',
            outputLineNumbers: [outputLine],
            sourceLineNumbers: [sourceLine],
            runtimeLineNumbers: [],
          })),
          coverageGaps: [],
        }),
      };

    } else value = await generate(messages, tools, options);

    return { ok: true, value: { tool_calls: [], finishReason: 'stop', ...(typeof value === 'string' ? { content: value } : value) } } as any;

  });

  return { gateway, execute, chat, turns };
}

export function fixtureIntent(goal: string, outputs: Array<{ type: string; filename: string }> = [], extra: Record<string, unknown> = {}) {

  return { intentType: outputs.length ? 'document_drafting' : 'general_qa', primaryGoal: goal, driverModel: 'primary-model', taskType: 'draft', isActionable: outputs.length > 0, chatResponseOnly: !outputs.length, workspaceMutationRequested: false, expectedDeliverables: outputs, ...extra };
}
