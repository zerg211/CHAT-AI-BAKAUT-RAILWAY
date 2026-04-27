import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildTurnPlannerPrompt } from '../src/ai/prompts.js';

describe('assistant prompt guardrails', () => {
  it('contains business restrictions without turning dialog into fixed scripts', () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain('Не работай как скрипт');
    expect(prompt).toContain('Не выдумывай технические характеристики');
    expect(prompt).toContain('не обещай наличие');
    expect(prompt).toContain('Не добавляй этот блок в обычные технические ответы');
    expect(prompt).toContain('стоимость владения');
    expect(prompt).toContain('не повод автоматически отправлять покупателя к дилеру');
    expect(prompt).toContain('сравнительный список или таблицу расходников/запчастей и цен в рублях');
    expect(prompt).toContain('Не подменяй стоимость расходников ценой самой машины');
    expect(prompt).toContain('Не показывай товарные карточки для технического сравнения');
    expect(prompt).toContain('российские маркетплейсы');
    expect(prompt).toContain('dyadko.ru');
    expect(prompt).toContain('пересчитай ее в рубли');
    expect(prompt).toContain('web search');
  });

  it('keeps specialist handoff contextual in turn planning', () => {
    const prompt = buildTurnPlannerPrompt();

    expect(prompt).toContain('Если последняя реплика покупателя касается точного наличия');
    expect(prompt).toContain('Не планируй handoff только потому, что в контексте есть товар');
    expect(prompt).toContain('практический сравнительный вывод');
    expect(prompt).toContain('не заменять цены расходников ценой самой техники');
    expect(prompt).toContain('dyadko.ru');
    expect(prompt).toContain('переводить зарубежные цены в рубли');
  });
});
