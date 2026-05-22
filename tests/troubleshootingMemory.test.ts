import { describe, expect, it } from 'vitest';
import {
  buildTroubleshootingCaseDraft,
  buildTroubleshootingSearchQuery,
  extractFaultCodes,
  isTroubleshootingQuestion,
  troubleshootingCaseCoversQuery
} from '../src/ai/troubleshootingMemory.js';
import type { TroubleshootingCase } from '../src/shared/types.js';

const question = 'Дизельный генератор АД 30С-Т400-1РКМ1 не глушится кнопкой стоп, на табло ошибка A25. В чем причина?';

describe('troubleshooting memory normalization', () => {
  it('extracts fault codes only from diagnostic context', () => {
    expect(extractFaultCodes(question)).toEqual(['A25']);
    expect(extractFaultCodes('Нужен генератор АД 30С-Т400-1РКМ1')).toEqual([]);
  });

  it('extracts fault codes before diagnostic terms', () => {
    expect(extractFaultCodes('АД 30С-Т400-1РКМ1 высветил A25, ошибка на табло.')).toEqual(['A25']);
  });

  it('normalizes spaced and hyphenated fault codes', () => {
    expect(extractFaultCodes('На дисплее ошибка A - 25, двигатель остановился.')).toEqual(['A25']);
  });

  it('does not extract catalog-like codes without diagnostic context', () => {
    expect(extractFaultCodes('Нужен фильтр A-25 для генератора и масло B12.')).toEqual([]);
  });

  it('builds a verified case draft from a sourced troubleshooting answer', () => {
    const draft = buildTroubleshootingCaseDraft({
      userMessage: question,
      answer: 'A25 связан с аварийной остановкой: контроллер не видит корректное завершение остановки за заданное время.',
      sourceUrls: ['https://example.com/manual.pdf']
    });

    expect(draft).toMatchObject({
      faultCodes: ['A25'],
      problemSummary: question,
      sourceUrls: ['https://example.com/manual.pdf']
    });
    expect(draft?.modelKey).toBeTruthy();
    expect(draft?.problemKey).toContain('a25');
  });

  it('matches a paraphrased question by same model and fault code', () => {
    const search = buildTroubleshootingSearchQuery(question);
    const item: TroubleshootingCase = {
      id: 'case-id',
      model: 'АД 30С-Т400-1РКМ1',
      modelKey: search.modelKeys[0],
      faultCodes: ['A25'],
      problemSummary: question,
      problemKey: 'a25__stop',
      answer: 'Проверьте цепь STOP и реле остановки.',
      sourceUrls: ['https://example.com/manual.pdf'],
      sourceTitles: [],
      confidence: 0.86,
      hitCount: 0,
      semanticScore: 0.7,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    expect(isTroubleshootingQuestion('АД 30С-Т400-1РКМ1 высветил A25 и мотор не останавливается, что смотреть?')).toBe(true);
    expect(troubleshootingCaseCoversQuery(item, 'АД 30С-Т400-1РКМ1 высветил A25 и мотор не останавливается, что смотреть?')).toBe(true);
    expect(troubleshootingCaseCoversQuery(item, 'Другой генератор показал A25 и не останавливается')).toBe(false);
  });
});
