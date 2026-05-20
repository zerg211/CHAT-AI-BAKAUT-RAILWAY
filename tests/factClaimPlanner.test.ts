import { describe, expect, it } from 'vitest';
import type { CardManifest, ExecutionContract, RequirementLedger } from '../src/shared/types.js';
import { auditAnswerFactClaims, buildFactClaimPlanner } from '../src/ai/factClaimPlanner.js';

const executionContract: ExecutionContract = {
  version: 1,
  source: 'agent_turn_contract',
  answerTask: 'product_selection',
  taskType: 'product_selection',
  catalogPolicy: 'find_matching_products',
  cardsPolicy: 'primary',
  leadPolicy: 'none',
  factPolicy: 'catalog_only',
  activeRequirementIds: ['req-generator'],
  postconditions: [],
  warnings: []
};

const requirementLedger: RequirementLedger = {
  version: 1,
  activeRequirementIds: ['req-generator'],
  primaryRequirementIds: ['req-generator'],
  alternativeMode: 'none',
  items: [{
    id: 'req-generator',
    kind: 'productClass',
    value: { productIntent: 'generator' },
    status: 'active',
    strictness: 'strictOnly',
    source: 'explicit_user',
    evidence: 'buyer asked for generator'
  }],
  hardConstraintKeys: ['productIntent'],
  warnings: []
};

describe('fact claim planner', () => {
  it('allows only catalog and visible-card facts for ordinary recommendation turns', () => {
    const planner = buildFactClaimPlanner({ executionContract, requirementLedger });

    expect(planner.allowedSources).toEqual(expect.arrayContaining(['conversation_memory', 'visible_cards', 'catalog']));
    expect(planner.allowedSources).not.toContain('web');
    expect(planner.risk).toBe('low');
    expect(planner.forbiddenClaims).toContain('do_not_invent_product_names_prices_specs');
  });

  it('requires specialist disclaimers for availability, delivery, discounts, and exact terms', () => {
    const planner = buildFactClaimPlanner({
      executionContract: {
        ...executionContract,
        answerTask: 'lead_handoff',
        taskType: 'pure_availability',
        factPolicy: 'specialist_required',
        leadPolicy: 'required_now'
      },
      requirementLedger
    });

    expect(planner.allowedSources).toContain('specialist');
    expect(planner.requiredDisclaimers).toContain('live_stock_delivery_discount_terms_require_specialist_verification');
    expect(planner.forbiddenClaims).toContain('do_not_promise_live_stock_delivery_discount_or_exact_terms');
    expect(planner.risk).toBe('high');
  });

  it('propagates visible card constraint warnings into claim policy', () => {
    const cardManifest: CardManifest = {
      version: 1,
      source: 'execution_contract',
      cardsPolicy: 'primary',
      visibleProductIds: ['bad-card'],
      hiddenProductIds: [],
      items: [],
      warnings: ['visible_card_constraint_violation:bad-card']
    };
    const planner = buildFactClaimPlanner({ executionContract, requirementLedger, cardManifest });

    expect(planner.warnings).toContain('visible_card_constraint_violation:bad-card');
    expect(planner.forbiddenClaims).toContain('do_not_name_visible_cards_with_constraint_violations_as_recommendations');
    expect(planner.risk).toBe('high');
  });

  it('extracts grounded product, price, and technical claims from a card-backed answer', () => {
    const planner = buildFactClaimPlanner({ executionContract, requirementLedger });
    const audit = auditAnswerFactClaims({
      answer: 'TSS SGG 8000EH стоит 82 000 руб. Это генератор 220 В.',
      factClaimPlanner: planner,
      cardManifest: {
        version: 1,
        source: 'execution_contract',
        cardsPolicy: 'primary',
        visibleProductIds: ['tss-8'],
        hiddenProductIds: [],
        items: [{
          productId: 'tss-8',
          name: 'TSS SGG 8000EH',
          rank: 1,
          visible: true,
          role: 'primary',
          constraintStatus: 'satisfies_hard_constraints',
          violations: []
        }],
        warnings: []
      }
    });

    expect(audit.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'product_reference', groundingStatus: 'grounded', matchedProductIds: ['tss-8'] }),
      expect.objectContaining({ kind: 'price', groundingStatus: 'grounded' }),
      expect.objectContaining({ kind: 'technical_spec', groundingStatus: 'grounded' })
    ]));
    expect(audit.warnings).toEqual([]);
  });

  it('grounds generator load calculation numbers in conversation memory without catalog cards', () => {
    const planner = buildFactClaimPlanner({
      executionContract: {
        ...executionContract,
        answerTask: 'technical_explanation',
        taskType: 'technical_answer',
        catalogPolicy: 'none',
        cardsPolicy: 'none',
        factPolicy: 'catalog_only'
      },
      requirementLedger
    });
    const audit = auditAnswerFactClaims({
      answer: 'По генератору сейчас держал бы ориентир на класс 8 кВт по номиналу, пусковая нагрузка около 7,7 кВт. Учитываю так: компрессор 2,2 кВт лучше считать отдельным пусковым сценарием. Расчет веду по сценариям: разовые потребители считаю отдельными сценариями, а не складываю все сразу. Самый тяжелый сценарий сейчас - компрессор вместе с базовой нагрузкой. Котел, холодильник, морозилка, связь и охрана должны работать постоянно.',
      factClaimPlanner: planner
    });

    expect(audit.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'technical_spec',
        requiredSource: 'conversation_memory',
        groundingStatus: 'grounded'
      })
    ]));
    expect(audit.warnings).not.toContain('technical_claim_without_catalog_context');
    expect(audit.warnings).not.toContain('availability_claim_without_specialist_verification_wording');
  });

  it('marks availability and delivery claims that lack specialist verification wording', () => {
    const planner = buildFactClaimPlanner({
      executionContract: {
        ...executionContract,
        answerTask: 'lead_handoff',
        taskType: 'pure_availability',
        factPolicy: 'specialist_required',
        leadPolicy: 'required_now'
      },
      requirementLedger
    });
    const audit = auditAnswerFactClaims({
      answer: 'Товар есть в наличии. Доставка будет бесплатной.',
      factClaimPlanner: planner
    });

    expect(audit.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'availability', groundingStatus: 'ungrounded' }),
      expect.objectContaining({ kind: 'delivery', groundingStatus: 'ungrounded' })
    ]));
    expect(audit.warnings).toEqual(expect.arrayContaining([
      'availability_claim_without_specialist_verification_wording',
      'delivery_claim_without_specialist_verification_wording'
    ]));
  });

  it('does not treat available options wording as live stock availability', () => {
    const audit = auditAnswerFactClaims({
      answer: 'For this driveway, the available options in the shown catalog cards are light plate compactors around 50-70 kg.',
      factClaimPlanner: buildFactClaimPlanner({
        executionContract: {
          ...executionContract,
          answerTask: 'product_selection',
          cardsPolicy: 'primary',
          factPolicy: 'catalog_only'
        },
        requirementLedger
      })
    });

    expect(audit.claims).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'availability' })
    ]));
    expect(audit.warnings).not.toContain('availability_claim_without_specialist_verification_wording');
  });

  it('does not treat operating conditions as commercial terms', () => {
    const audit = auditAnswerFactClaims({
      answer: '\u0412\u044b\u0431\u043e\u0440 \u0437\u0430\u0432\u0438\u0441\u0438\u0442 \u043e\u0442 \u043c\u043e\u0449\u043d\u043e\u0441\u0442\u0438, \u0440\u0435\u0441\u0443\u0440\u0441\u0430, \u0441\u0435\u0440\u0432\u0438\u0441\u0430 \u0438 \u0443\u0441\u043b\u043e\u0432\u0438\u0439 \u044d\u043a\u0441\u043f\u043b\u0443\u0430\u0442\u0430\u0446\u0438\u0438.',
      factClaimPlanner: buildFactClaimPlanner({ executionContract, requirementLedger })
    });

    expect(audit.claims).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'discount_or_terms' })
    ]));
    expect(audit.warnings).not.toContain('terms_claim_without_specialist_verification_wording');
  });

  it('marks current-lineup claims as web-required when web is not allowed by the policy', () => {
    const audit = auditAnswerFactClaims({
      answer: 'Эта модель актуальна в текущей линейке производителя.',
      factClaimPlanner: buildFactClaimPlanner({ executionContract, requirementLedger })
    });

    expect(audit.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'current_lineup',
        requiredSource: 'web',
        groundingStatus: 'ungrounded'
      })
    ]));
    expect(audit.warnings).toContain('current_lineup_claim_without_web_policy');
  });

  it('does not treat catalog card freshness wording as a manufacturer current-lineup claim', () => {
    const audit = auditAnswerFactClaims({
      answer: '\u0426\u0435\u043d\u0430 \u0432 \u043a\u0430\u0440\u0442\u043e\u0447\u043a\u0435: 54 000 RUB, \u0430\u043a\u0442\u0443\u0430\u043b\u044c\u043d\u043e\u0441\u0442\u044c \u043d\u0443\u0436\u043d\u043e \u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c.',
      factClaimPlanner: buildFactClaimPlanner({ executionContract, requirementLedger })
    });

    expect(audit.claims).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'current_lineup' })
    ]));
    expect(audit.warnings).not.toContain('current_lineup_claim_without_web_policy');
  });
});
