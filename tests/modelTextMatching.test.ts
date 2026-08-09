import { describe, expect, it } from 'vitest';
import { textMatchesOnlyTargetNames, textMatchesTargetName } from '../src/ai/modelTextMatching.js';

describe('exact product model text matching', () => {
  const target = 'TSS SGG 5000 EH';

  it('matches an exact split multi-part model code', () => {
    expect(textMatchesTargetName('Manual for TSS SGG 5000 EH generator', target)).toBe(true);
  });

  it('matches exact split parts across punctuation and explanatory words', () => {
    expect(textMatchesTargetName('TSS / SGG-5000 (EH) specification', target)).toBe(true);
    expect(textMatchesTargetName('TSS series SGG model 5000 version EH specification', target)).toBe(true);
  });

  it('extracts a split model identity from a descriptive catalog product name', () => {
    expect(textMatchesTargetName(
      'Official manual for TSS SGG 5000 EH',
      'Генератор бензиновый TSS SGG 5000 EH 5 кВт'
    )).toBe(true);
  });

  it.each([
    'Manual for TSS SGG 5000 E3 generator',
    'Manual for TSS SGG 5000 EHA generator',
    'Manual for TSS SGG 5000 EH-A generator'
  ])('rejects a neighboring split-model modification: %s', (sourceText) => {
    expect(textMatchesTargetName(sourceText, target)).toBe(false);
  });

  it('requires every decisive part of a split model code', () => {
    expect(textMatchesTargetName('Manual for TSS 5000 EH generator', target)).toBe(false);
  });

  it('rejects a neighboring suffix on a single-token model code', () => {
    expect(textMatchesTargetName('FIRMAN RD4910E1 specification', 'FIRMAN RD4910E')).toBe(false);
  });

  it('matches split and joined formatting of the same exact model identifier', () => {
    expect(textMatchesTargetName('Wacker Neuson MP12 operating manual', 'Wacker Neuson MP 12')).toBe(true);
    expect(textMatchesTargetName('Wacker Neuson MP 12 operating manual', 'Wacker Neuson MP12')).toBe(true);
  });

  it('does not confuse a neighboring joined identifier with the requested split identifier', () => {
    expect(textMatchesTargetName('Wacker Neuson MP13 operating manual', 'Wacker Neuson MP 12')).toBe(false);
  });

  it('requires semantic binding when a split-model source also names an unrequested neighboring modification', () => {
    const comparison = 'TSS SGG 5000 EH: 5.0 kW; TSS SGG 5000 EHA: 6.0 kW.';
    expect(textMatchesOnlyTargetNames(comparison, [target])).toBe(false);
  });

  it('allows a comparison source when every exact split model is an explicit target', () => {
    const comparison = 'TSS SGG 5000 EH: 5.0 kW; TSS SGG 5000 EHA: 6.0 kW.';
    expect(textMatchesOnlyTargetNames(comparison, [target, 'TSS SGG 5000 EHA'])).toBe(true);
  });
});
