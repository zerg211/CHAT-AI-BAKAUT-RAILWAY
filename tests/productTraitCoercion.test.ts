import { describe, expect, it } from 'vitest';

import {
  coerceNullableNumber,
  coerceProductIntent,
  coerceProductIntentList,
  coerceRequiredProductTraits,
  coerceStringList,
  emptyRequiredProductTraits,
  requiredTraitsHaveHardConstraints
} from '../src/ai/productTraitCoercion.js';

describe('product trait coercion', () => {
  it('keeps product intent and list coercion defaults stable', () => {
    expect(coerceProductIntent('generator')).toBe('generator');
    expect(coerceProductIntent('commercial')).toBe('unknown');
    expect(coerceProductIntent('bad')).toBe('unknown');

    expect(coerceProductIntentList([' generator ', 'generator', 'bad', 'plate', 'unknown'], 3)).toEqual(['generator', 'plate']);
    expect(coerceStringList([' a ', '', 42, 'b'], 3)).toEqual(['a', '42', 'b']);
    expect(coerceStringList('not-array')).toEqual([]);
  });

  it('keeps nullable positive number coercion stable', () => {
    expect(coerceNullableNumber(5)).toBe(5);
    expect(coerceNullableNumber('12.5')).toBe(12.5);
    expect(coerceNullableNumber(0)).toBeNull();
    expect(coerceNullableNumber(-1)).toBeNull();
    expect(coerceNullableNumber('')).toBeNull();
    expect(coerceNullableNumber('bad')).toBeNull();
  });

  it('keeps required trait fallback and hard-constraint detection stable', () => {
    const empty = emptyRequiredProductTraits();

    expect(empty).toEqual({
      productIntent: 'unknown',
      productRole: 'unknown',
      fuel: 'unknown',
      startType: 'unknown',
      enclosure: 'unknown',
      conventionalGenerator: null,
      singlePhase220: null,
      budgetMax: null,
      weightKgMin: null,
      weightKgMax: null,
      diameterMmMin: null,
      diameterMmMax: null,
      nominalPowerKwMin: null,
      nominalPowerKwMax: null,
      maxPowerKwMin: null,
      maxPowerKwMax: null,
      powerReasoning: ''
    });
    expect(requiredTraitsHaveHardConstraints(empty)).toBe(false);
    expect(requiredTraitsHaveHardConstraints({ ...empty, productIntent: 'plate' })).toBe(true);
    expect(requiredTraitsHaveHardConstraints({ ...empty, budgetMax: 100000 })).toBe(true);
  });

  it('coerces required product traits without changing allowed values or limits', () => {
    const longReason = 'x'.repeat(900);
    const traits = coerceRequiredProductTraits({
      productIntent: 'generator',
      productRole: 'coreProduct',
      fuel: 'diesel',
      startType: 'electric',
      enclosure: 'enclosed',
      conventionalGenerator: true,
      singlePhase220: false,
      budgetMax: '120000',
      weightKgMin: 80,
      weightKgMax: 0,
      diameterMmMin: '',
      diameterMmMax: 'bad',
      nominalPowerKwMin: 5,
      nominalPowerKwMax: '7.5',
      maxPowerKwMin: -1,
      maxPowerKwMax: 8,
      powerReasoning: longReason
    });

    expect(traits).toEqual({
      productIntent: 'generator',
      productRole: 'coreProduct',
      fuel: 'diesel',
      startType: 'electric',
      enclosure: 'enclosed',
      conventionalGenerator: true,
      singlePhase220: false,
      budgetMax: 120000,
      weightKgMin: 80,
      weightKgMax: null,
      diameterMmMin: null,
      diameterMmMax: null,
      nominalPowerKwMin: 5,
      nominalPowerKwMax: 7.5,
      maxPowerKwMin: null,
      maxPowerKwMax: 8,
      powerReasoning: longReason.slice(0, 800)
    });
  });
});
