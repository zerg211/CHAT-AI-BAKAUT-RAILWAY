import { describe, expect, it } from 'vitest';
import { emptyNeedState, heuristicNeedUpdate, mergeNeedState, mergeProductSelectionState } from '../src/ai/needState.js';
import { calculateGeneratorLoadProfile } from '../src/ai/loadProfile.js';

describe('need state extraction', () => {
  it('preserves simultaneous operation and unresolved apparent power across memory recomputation', () => {
    const profile = calculateGeneratorLoadProfile([
      { kind: 'pump', count: 1, runningKw: 1, startingKw: 3, source: 'explicit_user', operationMode: 'occasional' },
      { kind: 'compressor', count: 1, runningKw: 2, startingKw: 4, source: 'explicit_user', operationMode: 'occasional' }
    ], { simultaneousRunning: true, simultaneousStarting: true })!;
    const initial = mergeProductSelectionState(undefined, { loadProfile: profile });
    expect(initial.loadProfile?.requiredNominalKw).toBe(7);
    const replay = mergeProductSelectionState(JSON.parse(JSON.stringify(initial)), { loadProfile: { items: [] } });
    expect(replay.loadProfile?.requiredNominalKw).toBe(7);
    expect(replay.loadProfile?.simultaneousRunning).toBe(true);
    const revised = mergeProductSelectionState(replay, { loadProfile: { items: [
      { kind: 'pump', count: 1, source: 'explicit_user', operationMode: 'occasional',
        runningApparentPower: { kva: 2.5, evidence: 'PF not supplied' } }
    ] } });
    expect(revised.loadProfile?.requiredNominalKw).toBeUndefined();
    expect(revised.loadProfile?.missingRunningLoads).toContain('pump');
  });
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
