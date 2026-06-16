import { describe, expect, it } from 'vitest';
import {
  buildSalesManagerPolicyTrace,
  salesManagerBehaviorPolicyPromptBlock,
  salesManagerPlannerPolicyPromptBlock
} from '../src/ai/salesManagerBehaviorPolicy.js';

describe('dynamic sales manager policy routing', () => {
  it('selects stock, delivery, contact and cheap policy bundles from the live turn context', () => {
    const trace = buildSalesManagerPolicyTrace({
      target: 'answer',
      latestUserMessage: 'Есть в наличии? Доставите завтра? Хочу самый дешевый, телефон пока не дам.',
      enabled: true,
      shadowMode: false,
      maxRules: 9
    });

    expect(trace.mode).toBe('dynamic');
    expect(trace.tags).toEqual(expect.arrayContaining(['stock', 'delivery', 'contact', 'cheap']));
    expect(trace.reasonCodes).toEqual(expect.arrayContaining([
      'text:stock_or_availability',
      'text:delivery_or_logistics',
      'text:contact_or_phone',
      'text:cheap_or_budget'
    ]));
    expect(trace.selectedRuleCodes).toEqual(expect.arrayContaining([
      'core.help_first',
      'stock.no_false_stock_claim',
      'contact.ask_only_for_result',
      'cheap.preliminary_not_final'
    ]));
  });

  it('uses safe mandatory-only prompt in shadow mode while tracing what dynamic routing would have selected', () => {
    const trace = buildSalesManagerPolicyTrace({
      target: 'answer',
      latestUserMessage: 'Фото есть? и сравните ТСС с аналогами',
      enabled: true,
      shadowMode: true,
      maxRules: 8
    });

    expect(trace.mode).toBe('shadow');
    expect(trace.shadowSelectedRuleCodes).toEqual(expect.arrayContaining([
      'comparison.brand_orientation',
      'photo.prefer_bakaut_card'
    ]));
    expect(trace.selectedRuleCodes).not.toContain('photo.prefer_bakaut_card');
    expect(trace.promptBlock).toContain('DYNAMIC SALES POLICY');
  });

  it('keeps prompt text compact and principle-based, not fixed answer scripts', () => {
    const prompt = salesManagerBehaviorPolicyPromptBlock({
      target: 'answer',
      latestUserMessage: 'Нужно наличие, доставка и скидка',
      maxRules: 8
    });

    expect(prompt).toContain('DYNAMIC SALES POLICY');
    expect(prompt).toContain('не готовые ответы');
    expect(prompt).not.toMatch(/напиши клиенту:/iu);
    expect(prompt.length).toBeLessThan(3000);
  });

  it('planner policy can route correction/photo/cheap edge cases separately from final answer policy', () => {
    const prompt = salesManagerPlannerPolicyPromptBlock({
      target: 'planner',
      latestUserMessage: 'Ты ошибся, дай фото и самый дешевый вариант',
      maxRules: 9
    });

    expect(prompt).toContain('correction.verify_before_apology');
    expect(prompt).toContain('photo.prefer_bakaut_card');
    expect(prompt).toContain('cheap.preliminary_not_final');
  });
});
