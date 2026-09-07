import { describe, it, expect } from 'vitest';
import { canonicalFactAttribute, normalizedFactValue, verifiedFactValueKey } from '../src/ai/verifiedFactNormalization.js';

describe('verified technical quantities preserve meaning', () => {
  it.each([['70 кг', '70000 г'], ['5 кВт', '5000 Вт'], ['0,5 кВт', '500 W'], ['10 мм', '1 см']])(
    'equates physical units %s and %s', (left, right) => {
      expect(normalizedFactValue(left)).toEqual(normalizedFactValue(right));
    }
  );
  it.each([['5 кВт', '5 кВА'], ['70 кг без топлива', '70 кг'], ['5 кВт при 220 В', '5 кВт при 380 В'],
    ['не более 70 кг', '70 кг'], ['70–80 кг', '70 кг'], ['нет', 'да'], ['5000', '5 кВт']])(
    'does not erase conditions/negation or invent units: %s vs %s', (left, right) => {
      expect(normalizedFactValue(left)).not.toEqual(normalizedFactValue(right));
    }
  );
  it('does not merge nominal, peak or qualified attributes', () => {
    expect(canonicalFactAttribute('Номинальная мощность')).not.toBe(canonicalFactAttribute('Максимальная мощность'));
    expect(canonicalFactAttribute('Масса')).not.toBe(canonicalFactAttribute('Транспортная масса'));
    expect(verifiedFactValueKey({attribute:'Масса',value:'70 кг'})).toBe(
      verifiedFactValueKey({attribute:'Weight',value:'70000 g'}));
  });
});
