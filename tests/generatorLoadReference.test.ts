import { describe, expect, it } from 'vitest';
import {
  classifyGeneratorLoadText,
  generatorReferenceLoadItemsFromText,
  generatorReferenceTable
} from '../src/ai/generatorLoadReference.js';

describe('generator load reference table', () => {
  it('contains curated classes with wattage ranges, startup factors, and source notes', () => {
    expect(generatorReferenceTable.length).toBeGreaterThanOrEqual(20);
    expect(generatorReferenceTable.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'lighting_led',
      'small_electronics',
      'handheld_drill',
      'angle_grinder',
      'rotary_hammer',
      'refrigerator',
      'surface_pump',
      'submersible_pump',
      'air_compressor',
      'resistive_heater',
      'unknown_named_load'
    ]));
    for (const entry of generatorReferenceTable) {
      expect(entry.loadClass).toBeTruthy();
      expect(entry.importantParameters.length).toBeGreaterThan(0);
      expect(entry.howToDeterminePower).toBeTruthy();
      expect(entry.sourceNote).toBeTruthy();
      if (entry.canEstimate) {
        expect(entry.runningKwTypical).toBeTruthy();
        expect(entry.startingFactorTypical).toBeTruthy();
      }
    }
  });

  it('classifies unknown handheld tools into cautious estimated electrical load items', () => {
    const detections = classifyGeneratorLoadText('Нужен генератор: свет и болгарка или дрель, мощность не знаю');
    expect(detections.map((item) => item.reference.id)).toEqual(expect.arrayContaining(['angle_grinder', 'handheld_drill', 'lighting_led']));

    const items = generatorReferenceLoadItemsFromText('Нужен генератор: свет и болгарка или дрель, мощность не знаю');
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'handheld_tool', name: 'ручной электроинструмент', runningKw: 1.5, startingKw: 3, source: 'estimated_average' }),
      expect.objectContaining({ kind: 'lighting', name: 'свет', runningKw: 0.5, startingKw: 0.5, source: 'estimated_average' })
    ]));
  });

  it('keeps occasional handheld tools out of the simultaneous active load', () => {
    const text = 'Нужен генератор: свет и иногда болгарка или дрель, мощность не знаю';
    const detections = classifyGeneratorLoadText(text);
    expect(detections.filter((item) => ['angle_grinder', 'handheld_drill'].includes(item.reference.id)).every((item) => item.role === 'staged')).toBe(true);

    const items = generatorReferenceLoadItemsFromText(text);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'lighting', name: 'свет', runningKw: 0.5, startingKw: 0.5, source: 'estimated_average' })
    ]));
    expect(items.some((item) => item.kind === 'handheld_tool')).toBe(false);
  });

  it('does not invent power for fully unknown/high-risk named equipment', () => {
    const detections = classifyGeneratorLoadText('Есть какой-то станок, мощность не знаю');
    expect(detections.map((item) => item.reference.id)).toContain('unknown_named_load');
    expect(generatorReferenceLoadItemsFromText('Есть какой-то станок, мощность не знаю')).toEqual([]);
  });

  it('keeps motor/pump loads cautious because startup dominates generator sizing', () => {
    const items = generatorReferenceLoadItemsFromText('Нужен генератор для скважинного насоса, мощность не знаю');
    expect(items).toEqual([
      expect.objectContaining({ kind: 'pump', name: 'скважинный насос', runningKw: 1.1, startingKw: 4, source: 'estimated_average' })
    ]);
  });
});
