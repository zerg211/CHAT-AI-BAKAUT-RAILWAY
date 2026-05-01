import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyGeneratorLoadText,
  generatorReferenceLoadItemsFromText,
  loadPersistedGeneratorReferenceEntries,
  shouldEnrichGeneratorLoadReference,
  upsertGeneratorLoadReferenceEntry
} from '../src/ai/generatorLoadReference.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bakaut-generator-reference-'));
  process.env.GENERATOR_LOAD_REFERENCE_PATH = join(tempDir, 'generator-load-reference-overrides.json');
});

afterEach(() => {
  delete process.env.GENERATOR_LOAD_REFERENCE_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dynamic generator load reference enrichment', () => {
  it('requires enrichment when a generator buyer names an unknown consumer', () => {
    expect(shouldEnrichGeneratorLoadReference('нужен генератор для инкубатора, мощность не знаю')).toBe(true);
    expect(shouldEnrichGeneratorLoadReference('нужен генератор для болгарки и света')).toBe(false);
  });

  it('persists enriched consumers and uses them in later lookups', () => {
    const saved = upsertGeneratorLoadReferenceEntry({
      id: 'incubator',
      loadClass: 'small_electronics_load',
      consumers: ['инкубатор'],
      aliases: ['инкубатор', 'инкубатора'],
      importantParameters: ['модель', 'мощность нагревателя', 'вентилятор/автоматика'],
      howToDeterminePower: 'По паспорту инкубатора; без модели использовать осторожный веб-ориентир.',
      runningKwTypical: [0.1, 0.5],
      conservativeRunningKw: 0.5,
      startingFactorTypical: [1, 1.2],
      conservativeStartingKw: 0.6,
      confidence: 'low',
      canEstimate: true,
      preliminaryQuestion: 'Какая модель/паспортная мощность инкубатора?',
      sourceNote: 'web_average: public manufacturer/spec examples; verify by model/nameplate before final selection.'
    });

    expect(saved.id).toBe('runtime_incubator');
    expect(loadPersistedGeneratorReferenceEntries()).toHaveLength(1);
    expect(classifyGeneratorLoadText('генератор для инкубатора').map((item) => item.reference.id)).toContain('runtime_incubator');

    const items = generatorReferenceLoadItemsFromText('генератор для инкубатора');
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'small_electronics_load',
        name: 'инкубатор',
        runningKw: 0.5,
        startingKw: 0.6,
        source: 'web_average'
      })
    ]));
  });

  it('does not enrich again when a known persisted consumer cannot be safely estimated', () => {
    upsertGeneratorLoadReferenceEntry({
      id: 'industrial_press',
      loadClass: 'workshop_industrial_load',
      consumers: ['пресс'],
      aliases: ['пресс', 'гидравлический пресс'],
      importantParameters: ['модель', 'паспортная мощность', 'фаза 220/380 В'],
      howToDeterminePower: 'Только по паспорту/шильдику или модели; средний веб-ориентир небезопасен.',
      confidence: 'low',
      canEstimate: false,
      preliminaryQuestion: 'Какая модель пресса, фаза 220/380 В и паспортная мощность?',
      sourceNote: 'web_average: generic industrial press data varies too much; do not estimate without model/nameplate.'
    });

    expect(generatorReferenceLoadItemsFromText('нужен генератор для гидравлического пресса')).toHaveLength(0);
    expect(classifyGeneratorLoadText('нужен генератор для гидравлического пресса').map((item) => item.reference.id)).toContain('runtime_industrial_press');
    expect(shouldEnrichGeneratorLoadReference('нужен генератор для гидравлического пресса')).toBe(false);
  });

  it('updates an existing persisted consumer instead of duplicating it', () => {
    upsertGeneratorLoadReferenceEntry({
      id: 'incubator',
      loadClass: 'small_electronics_load',
      consumers: ['инкубатор'],
      aliases: ['инкубатор'],
      importantParameters: ['модель'],
      howToDeterminePower: 'По паспорту.',
      runningKwTypical: [0.1, 0.5],
      conservativeRunningKw: 0.5,
      startingFactorTypical: [1, 1.2],
      conservativeStartingKw: 0.6,
      confidence: 'low',
      canEstimate: true,
      preliminaryQuestion: 'Какая модель?',
      sourceNote: 'web_average: source A.'
    });
    upsertGeneratorLoadReferenceEntry({
      id: 'incubator',
      loadClass: 'small_electronics_load',
      consumers: ['инкубатор'],
      aliases: ['инкубатор', 'инкубаторы'],
      importantParameters: ['модель', 'количество'],
      howToDeterminePower: 'По паспорту или модели.',
      runningKwTypical: [0.1, 0.7],
      conservativeRunningKw: 0.7,
      startingFactorTypical: [1, 1.2],
      conservativeStartingKw: 0.8,
      confidence: 'low',
      canEstimate: true,
      preliminaryQuestion: 'Какая модель и сколько инкубаторов?',
      sourceNote: 'web_average: source B.'
    });

    const entries = loadPersistedGeneratorReferenceEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].conservativeRunningKw).toBe(0.7);
    expect(entries[0].aliases).toContain('инкубаторы');
  });
});
