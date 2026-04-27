import { describe, expect, it } from 'vitest';
import { emptyNeedState, heuristicNeedUpdate, mergeNeedState } from '../src/ai/needState.js';

describe('need state extraction', () => {
  it('extracts explicit and implicit needs from one buyer message', () => {
    const update = heuristicNeedUpdate('Нужна виброплита для дачи, чтобы жена могла переносить, и желательно недорого');

    expect(update.explicitNeeds?.some((item) => item.value.includes('виброплиты'))).toBe(true);
    expect(update.implicitNeeds?.some((item) => item.value.includes('вес'))).toBe(true);
    expect(update.implicitNeeds?.some((item) => item.value.includes('бюджет'))).toBe(true);
  });

  it('keeps the product target but stops mixing stale situational needs after a refinement', () => {
    const initial = mergeNeedState(emptyNeedState(), heuristicNeedUpdate('Нужен генератор для дачи'));
    const updated = mergeNeedState(initial, heuristicNeedUpdate('Теперь смотрю вариант для бригады каждый день'));

    expect(updated.explicitNeeds.length).toBeGreaterThan(0);
    expect(updated.implicitNeeds.some((item) => item.value.includes('регулярную нагрузку'))).toBe(true);
    expect(updated.implicitNeeds.some((item) => item.value.includes('бытового использования'))).toBe(false);
  });
});
