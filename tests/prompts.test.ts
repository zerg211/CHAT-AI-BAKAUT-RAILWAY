import { describe, expect, it } from 'vitest';
import { emptyNeedState, emptyProductSelectionState } from '../src/ai/needState.js';
import { __test_buildCompactAnswerSystemPrompt } from '../src/ai/assistant.js';
import { buildAssistantContext, buildSystemPrompt, buildTurnPlannerPrompt } from '../src/ai/prompts.js';

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
    expect(prompt).toContain('agentContractV2 is the canonical semantic contract');
    expect(prompt).toContain('Never use web as proof of BAKAUT live stock');
    expect(prompt).toContain('переводить зарубежные цены в рубли');
  });

  it('requires concrete technical questions to be answered before clarifying missing inputs', () => {
    const prompt = buildTurnPlannerPrompt();

    expect(prompt).toContain('For concrete technical questions or comparisons with incomplete inputs');
    expect(prompt).toContain('do not plan a clarification-only answer');
    expect(prompt).toContain("answer the buyer's concrete question before clarifying");
  });

  it('keeps catalog option availability as product selection with cards', () => {
    const prompt = buildTurnPlannerPrompt();

    expect(prompt).toContain('Decision boundary for availability vs selection');
    expect(prompt).toContain('taskType="product_selection_with_availability"');
    expect(prompt).toContain('productCardsPolicy="show_matching_products"');
    expect(prompt).toContain('it does not mean text-only pure availability');
    expect(prompt).toContain('Do not set catalogAction="verify_catalog_absence"');
  });

  it('injects the compiled sales-manager policy as compact principles, not a fixed script dump', () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain('DYNAMIC SALES POLICY');
    expect(prompt).toContain('core.help_first');
    expect(prompt).toContain('stock.no_false_stock_claim');
    expect(prompt).toContain('cards.explain_compromise');
    expect(prompt).toContain('contact.ask_only_for_result');
    expect(prompt).toContain('не готовые ответы');
    expect(prompt).not.toContain('11) Исправления и ошибки');
  });

  it('injects the sales-manager policy into the compact final-answer runtime prompt', () => {
    const prompt = __test_buildCompactAnswerSystemPrompt('Есть в наличии и можно забрать сегодня?');

    expect(prompt).toContain('DYNAMIC SALES POLICY');
    expect(prompt).toContain('stock.no_false_stock_claim');
    expect(prompt).toContain('contact.ask_only_for_result');
    expect(prompt).toContain('не готовые ответы');
  });

  it('keeps planner decisions aligned with compiled contact timing and compromise rules', () => {
    const prompt = buildTurnPlannerPrompt();

    expect(prompt).toContain('DYNAMIC SALES POLICY');
    expect(prompt).toContain('contact.ask_only_for_result');
    expect(prompt).toContain('stock.no_false_stock_claim');
    expect(prompt).toContain('cards.explain_compromise');
    expect(prompt).toContain('Buyer corrections require evidence check before apologizing');
  });

  it('builds a compact final-answer context for low-token turns', () => {
    const context = buildAssistantContext({
      needState: {
        ...emptyNeedState(),
        activeNeeds: [],
        explicitNeeds: [{ value: 'generator 5-6 kW', evidence: 'user', confidence: 0.9, updatedAt: 'now' }],
        implicitNeeds: [],
        constraints: [{ value: 'inverter enclosed budget', evidence: 'user', confidence: 0.8, updatedAt: 'now' }],
        importantCriteria: [],
        confirmedFacts: [],
        uncertainInferences: [],
        contradictions: [],
        featureSignals: {
          portable: 0,
          homeUse: 0.8,
          compact: 0.3,
          lowNoise: 0.9,
          coldStart: 0,
          professionalDuty: 0,
          budgetSensitive: 0.7
        },
        selectionState: emptyProductSelectionState(),
        lastSummary: 'buyer needs a compact inverter enclosed generator'
      },
      products: [{
        id: 'p1',
        name: 'Test Generator',
        brand: 'Test',
        category: 'Generators',
        price: 100000,
        currency: 'RUB',
        sourceUrl: 'https://example.test/product',
        imageUrl: null,
        description: 'x'.repeat(2000),
        specs: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`spec-${index}`, 'y'.repeat(200)]))
      }],
      knowledgePages: [{
        id: 'k1',
        title: 'Manual',
        pageType: 'manual',
        sourceUrl: 'https://example.test/manual',
        summary: 's'.repeat(1000),
        content: 'c'.repeat(2000),
        raw: {},
        createdAt: 'now',
        updatedAt: 'now'
      }],
      conflicts: [],
      messages: Array.from({ length: 8 }, (_, index) => ({
        id: String(index),
        sessionId: 's1',
        role: index % 2 ? 'assistant' : 'user',
        content: `message-${index} ${'z'.repeat(1000)}`,
        metadata: {},
        createdAt: 'now'
      }))
    }, { mode: 'compact' });

    expect(context.contextMode).toBe('compact');
    expect(context.conversationHistory).toHaveLength(4);
    expect(context.catalogCandidates[0]?.roleHint).toBe('coreProduct');
    expect(context.catalogCandidates[0]?.summary?.length).toBeLessThanOrEqual(223);
    expect(Object.keys(context.catalogCandidates[0]?.specs ?? {})).toHaveLength(7);
    expect(context.knowledgePages[0]?.contentExcerpt).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain('example.test/product');
  });
});
