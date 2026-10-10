import { expect, it } from 'vitest';
import { RunSessions } from '../../frontend/src/lib/run-sessions.js';

it('retains background events under their own chat and run identity', () => {
  const sessions = new RunSessions();
  sessions.record({type:'run_registered',runId:'one',chatId:'chat-one',mode:'work'});
  sessions.record({type:'run_registered',runId:'two',chatId:'chat-two',mode:'chat'});
  sessions.record({type:'run_state',runId:'one',state:'awaiting_confirmation'});
  sessions.record({type:'run_state',runId:'two',state:'completed'});
  expect(sessions.belongsTo('one','chat-two')).toBe(false);
  expect(sessions.belongsTo('two','chat-two')).toBe(true);
  expect(sessions.states.get('one')).toBe('awaiting_confirmation');
  expect(sessions.events.get('two')).not.toContainEqual(expect.objectContaining({runId:'one'}));
  expect(sessions.latest.get('chat-one')).toBe('one');
});

it('keeps the most recent run per chat without dropping earlier run ownership', () => {
  const sessions = new RunSessions();
  sessions.register('old','chat','agent');sessions.register('new','chat','chat');
  expect(sessions.latest.get('chat')).toBe('new');
  expect(sessions.belongsTo('old','chat')).toBe(true);
  expect(sessions.modes.get('old')).toBe('agent');
  sessions.record({type:'assistant_message_chunk',runId:'old',messageId:'message',modelId:'primary-model',chunk:'hidden'} as any);
  expect(sessions.events.has('old')).toBe(false);
});
