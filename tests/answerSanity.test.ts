import { describe, expect, it } from 'vitest';
import { sanitizeVisibleAnswerNumbers } from '../src/ai/answerSanity.js';

describe('sanitizeVisibleAnswerNumbers', () => {
  it('normalizes descending kW ranges without inventing facts', () => {
    expect(sanitizeVisibleAnswerNumbers('По нагрузке нужен диапазон 4–3,5 кВт.'))
      .toBe('По нагрузке нужен диапазон 3,5–4 кВт.');
  });

  it('collapses degenerate power ranges to a single value', () => {
    expect(sanitizeVisibleAnswerNumbers('Для этой задачи достаточно 5-5 кВт.'))
      .toBe('Для этой задачи достаточно 5 кВт.');
  });

  it('keeps already sane ranges unchanged', () => {
    expect(sanitizeVisibleAnswerNumbers('Ориентир по мощности — 3,5–4 кВт.'))
      .toBe('Ориентир по мощности — 3,5–4 кВт.');
  });

  it('normalizes word ranges with Russian decimal comma', () => {
    expect(sanitizeVisibleAnswerNumbers('Пусковой запас лучше держать от 4 до 3.5 кВА.'))
      .toBe('Пусковой запас лучше держать от 3,5 до 4 кВА.');
  });
});
