import { describe, expect, it } from 'vitest';
import type { Message } from '../src/shared/types.js';
import { priorVisibleProductsFromHistory } from '../src/ai/agentManagerOrchestrator.js';

function message(role: Message['role'], content: string, productCards?: Array<Record<string, unknown>>): Message {
  return {
    id: `${role}-${Math.random().toString(36).slice(2)}`,
    sessionId: 's',
    role,
    content,
    metadata: productCards ? { productCards } : {},
    createdAt: new Date('2026-08-24T12:00:00.000Z').toISOString()
  } as unknown as Message;
}

describe('priorVisibleProductsFromHistory', () => {
  it('collects unique product cards from assistant messages in reverse order', () => {
    const history = [
      message('user', 'нужен генератор'),
      message('assistant', 'вот варианты', [
        { id: 'ap5500', name: 'A-iPower LITE AP5500 (5,0 кВт)', price: 48990, brand: 'A-iPower' },
        { id: 'kb5000', name: 'Zongshen KB 5000 (4,0 кВт)', price: 49990, brand: 'Zongshen' }
      ]),
      message('user', 'а с кондиционером?'),
      message('assistant', 'подходит только AP5500', [
        { id: 'ap5500', name: 'A-iPower LITE AP5500 (5,0 кВт)', price: 48990, brand: 'A-iPower' },
        { id: 'kb5000e', name: 'Zongshen KB 5000E (4,0 кВт)', price: 54990, brand: 'Zongshen' }
      ])
    ];
    const prior = priorVisibleProductsFromHistory(history);
    expect(prior).toHaveLength(3);
    // Newest assistant message first; within a card list the original order is kept.
    expect(prior.map((p) => p.id)).toEqual(['ap5500', 'kb5000e', 'kb5000']);
    expect(prior.find((p) => p.id === 'ap5500')?.price).toBe(48990);
  });

  it('ignores user messages and assistant messages without cards', () => {
    const history = [
      message('user', 'привет'),
      message('assistant', 'ответ без карточек')
    ];
    expect(priorVisibleProductsFromHistory(history)).toEqual([]);
  });
});
