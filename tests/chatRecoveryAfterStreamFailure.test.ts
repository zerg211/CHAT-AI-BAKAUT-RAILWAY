import { describe, expect, it } from 'vitest';
import { findCompletedAnswerForRetry } from '../src/client/chatHistory.js';
import type { RestoredChatMessage } from '../src/client/chatHistory.js';

function user(content: string): RestoredChatMessage {
  return { id: `u-${content.length}`, role: 'user', content } as RestoredChatMessage;
}

function assistant(content: string): RestoredChatMessage {
  return { id: `a-${content.length}`, role: 'assistant', content } as RestoredChatMessage;
}

describe('findCompletedAnswerForRetry', () => {
  it('returns the persisted answer when the live stream broke', () => {
    const messages = [user('генератор нужен'), assistant('Подойдет модель около 4 кВт.')];
    expect(findCompletedAnswerForRetry(messages, 'генератор нужен')?.content)
      .toBe('Подойдет модель около 4 кВт.');
  });

  it('ignores answers written before the retried question', () => {
    const messages = [assistant('Старый ответ.'), user('генератор нужен')];
    expect(findCompletedAnswerForRetry(messages, 'генератор нужен')).toBeNull();
  });

  it('ignores empty answers and matches the latest question', () => {
    const messages = [
      user('первый вопрос'),
      assistant('Первый ответ.'),
      user('генератор нужен'),
      assistant('   ')
    ];
    expect(findCompletedAnswerForRetry(messages, 'генератор нужен')).toBeNull();
  });

  it('returns null for blank questions', () => {
    expect(findCompletedAnswerForRetry([assistant('Ответ.')], '   ')).toBeNull();
  });
});
