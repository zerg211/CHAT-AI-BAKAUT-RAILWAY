import { describe, expect, it } from 'vitest';
import { ConsistencyGuard } from '../src/ai/consistencyGuard.js';
import type { Product } from '../src/shared/types.js';

const generator: Product = {
  id: 'tss-8',
  name: 'TSS SGG 8000EH',
  brand: 'TSS',
  category: 'Генераторы',
  price: 82000,
  currency: 'RUB',
  specs: {}
};

const otherGenerator: Product = {
  id: 'other-8',
  name: 'Other DG 8000',
  brand: 'Other',
  category: 'Генераторы',
  price: 76000,
  currency: 'RUB',
  specs: {}
};

describe('consistency guard', () => {
  it('records stated product prices in the consistency context', () => {
    const guard = new ConsistencyGuard();
    guard.recordFacts([generator], 'TSS SGG 8000EH сейчас стоит 82000 рублей.');

    expect(guard.buildConsistencyContext()).toContain('TSS SGG 8000EH: price: 82000');
  });

  it('does not warn when the same price is restated with spaces and RUB suffix', () => {
    const guard = new ConsistencyGuard();
    guard.recordFacts([generator], 'TSS SGG 8000EH сейчас стоит 82000 рублей.');

    expect(guard.checkAnswer('TSS SGG 8000EH по той же цене: 82 000 руб.')).toEqual([]);
  });

  it('warns when a later answer states a different RUB price for the same product', () => {
    const guard = new ConsistencyGuard();
    guard.recordFacts([generator], 'TSS SGG 8000EH сейчас стоит 82000 рублей.');

    expect(guard.checkAnswer('TSS SGG 8000EH сейчас якобы стоит 76 000 руб.')).toEqual([
      'Price inconsistency for "TSS SGG 8000EH": previously 82000, now 76000'
    ]);
  });

  it('does not warn for a different product price mention', () => {
    const guard = new ConsistencyGuard();
    guard.recordFacts([generator], 'TSS SGG 8000EH сейчас стоит 82000 рублей.');

    expect(guard.checkAnswer('Other DG 8000 сейчас стоит 76 000 руб.')).toEqual([]);
  });

  it('restores price facts from assistant history without regex parsing', () => {
    const guard = new ConsistencyGuard();
    guard.restoreFromHistory([
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: 'TSS SGG 8000EH сейчас стоит 82000 рублей.',
        metadata: {},
        createdAt: new Date().toISOString()
      }
    ], [generator, otherGenerator]);

    expect(guard.checkAnswer('TSS SGG 8000EH сейчас якобы стоит 76 000 ₽.')).toEqual([
      'Price inconsistency for "TSS SGG 8000EH": previously 82000, now 76000'
    ]);
  });
});
