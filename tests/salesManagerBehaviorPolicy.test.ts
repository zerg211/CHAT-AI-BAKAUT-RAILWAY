import { describe, expect, it } from 'vitest';
import {
  buildSalesManagerPolicyTrace,
  SALES_MANAGER_POLICY_PACK_HASH,
  SALES_MANAGER_POLICY_PACK_VERSION,
  salesManagerBehaviorPolicyPromptBlock,
  salesManagerPlannerPolicyPromptBlock
} from '../src/ai/salesManagerBehaviorPolicy.js';

describe('dynamic sales manager policy routing', () => {
  it('selects optional rules only from structured planner semantics, not keyword matching', () => {
    const trace = buildSalesManagerPolicyTrace({
      target: 'answer',
      latestUserMessage: 'Есть в наличии? Доставите завтра? Хочу самый дешевый, телефон пока не дам.',
      semanticRuleIds: ['contact.refusal_no_pressure', 'cheap.preliminary_not_final'],
      riskFlags: ['availability', 'delivery', 'lead'],
      enabled: true,
      shadowMode: false,
      maxRules: 9
    });

    expect(trace.mode).toBe('dynamic');
    expect(trace.tags).toEqual([]);
    expect(trace.reasonCodes).toEqual(expect.arrayContaining([
      'structured_risk:availability',
      'structured_risk:delivery',
      'structured_risk:lead',
      'planner_rule:cheap.preliminary_not_final'
    ]));
    expect(trace.selectedRuleCodes).toEqual(expect.arrayContaining([
      'core.help_first',
      'stock.no_false_stock_claim',
      'contact.ask_only_for_result',
      'contact.refusal_no_pressure',
      'cheap.preliminary_not_final'
    ]));
    expect(trace.policyPackVersion).toBe(SALES_MANAGER_POLICY_PACK_VERSION);
    expect(trace.policyPackHash).toBe(SALES_MANAGER_POLICY_PACK_HASH);
  });

  it('uses safe mandatory-only prompt in shadow mode while tracing what dynamic routing would have selected', () => {
    const trace = buildSalesManagerPolicyTrace({
      target: 'answer',
      latestUserMessage: 'Фото есть? и сравните ТСС с аналогами',
      semanticRuleIds: ['comparison.brand_orientation', 'photo.prefer_bakaut_card'],
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
      semanticRuleIds: ['contact.ask_only_for_result'],
      maxRules: 8
    });

    expect(prompt).toContain('DYNAMIC SALES POLICY');
    expect(prompt).toContain('не готовые ответы');
    expect(prompt.toLocaleLowerCase('ru')).not.toContain('напиши клиенту:');
    expect(prompt.length).toBeLessThan(3000);
  });

  it('planner policy can route correction/photo/cheap edge cases separately from final answer policy', () => {
    const prompt = salesManagerPlannerPolicyPromptBlock({
      target: 'planner',
      latestUserMessage: 'Ты ошибся, дай фото и самый дешевый вариант',
      maxRules: 10
    });

    expect(prompt).toContain('correction.verify_before_apology');
    expect(prompt).toContain('photo.prefer_bakaut_card');
    expect(prompt).toContain('cheap.preliminary_not_final');
  });

  it('routes ambiguous cutter requests to a material/work clarification policy', () => {
    const trace = buildSalesManagerPolicyTrace({
      target: 'answer',
      latestUserMessage: 'мне нужен резчик че у вас есть?',
      semanticRuleIds: ['selection.cutter_ambiguous_material_question'],
      enabled: true,
      shadowMode: false,
      maxRules: 9
    });

    expect(trace.tags).toEqual([]);
    expect(trace.reasonCodes).toContain('planner_rule:selection.cutter_ambiguous_material_question');
    expect(trace.selectedRuleCodes).toContain('selection.cutter_ambiguous_material_question');
    expect(trace.promptBlock).toContain('по какому материалу');
    expect(trace.promptBlock).toContain('шовнарезчик');
    expect(trace.promptBlock).toContain('бензорез');
    expect(trace.promptBlock).not.toContain('напиши клиенту:');
  });
});
