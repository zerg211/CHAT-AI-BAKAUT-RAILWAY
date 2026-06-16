import { describe, expect, it } from 'vitest';
import type { CardManifest, FactClaimPlanner, LeadStateMachine, ProductEvidenceRegistry } from '../src/shared/types.js';
import {
  classifyPostAnswerRecovery,
  repairAnswerForPostAnswerVerification,
  verifyPostAnswer
} from '../src/ai/postAnswerVerifier.js';

const factClaimPlanner: FactClaimPlanner = {
  version: 1,
  factPolicy: 'catalog_only',
  allowedSources: ['catalog', 'visible_cards', 'conversation_memory'],
  requiredDisclaimers: [],
  forbiddenClaims: ['do_not_invent_product_names_prices_specs'],
  risk: 'low',
  warnings: []
};

const leadStateMachine: LeadStateMachine = {
  version: 1,
  state: 'not_needed',
  nextAction: 'answer_without_lead',
  leadPolicy: 'none',
  hasContactInTurn: false,
  leadRequested: false,
  leadCreated: false,
  warnings: []
};

const cardManifest: CardManifest = {
  version: 1,
  source: 'execution_contract',
  cardsPolicy: 'primary',
  visibleProductIds: ['tss-8'],
  hiddenProductIds: [],
  items: [{
    productId: 'tss-8',
    name: 'TSS SGG 8000EH gasoline generator 220 V',
    rank: 1,
    visible: true,
    role: 'primary',
    constraintStatus: 'satisfies_hard_constraints',
    violations: []
  }],
  warnings: []
};

const productEvidenceRegistry: ProductEvidenceRegistry = {
  version: 1,
  visibleProductIds: ['tss-8'],
  hiddenProductIds: [],
  rejectedProductIds: ['bad'],
  allowedProductIdsForText: ['tss-8'],
  warnings: [],
  items: [
    {
      productId: 'tss-8',
      name: 'TSS SGG 8000EH gasoline generator 220 V',
      source: 'visible_card',
      role: 'primary',
      allowedInAnswerText: true,
      allowedAsVisibleCard: true,
      constraintStatus: 'satisfies_hard_constraints',
      evidence: []
    },
    {
      productId: 'bad',
      name: 'Other 2 kW generator',
      source: 'catalog',
      role: 'rejected',
      allowedInAnswerText: false,
      allowedAsVisibleCard: false,
      rejectionReason: 'hard constraints',
      constraintStatus: 'violates_hard_constraints',
      evidence: []
    }
  ]
};

describe('post-answer verifier', () => {
  it('passes an aligned catalog answer', () => {
    const result = verifyPostAnswer({
      answer: 'TSS SGG 8000EH подходит как бензиновый генератор 220 В с запасом по мощности.',
      factClaimPlanner,
      leadStateMachine,
      cardManifest
    });

    expect(result.status).toBe('pass');
    expect(result.issues).toEqual([]);
  });

  it('flags contact pressure when lead policy forbids contact collection', () => {
    const result = verifyPostAnswer({
      answer: 'Оставьте телефон и имя, я передам заявку.',
      factClaimPlanner,
      leadStateMachine: {
        ...leadStateMachine,
        state: 'not_allowed',
        nextAction: 'do_not_ask_contact',
        leadPolicy: 'forbidden'
      },
      cardManifest
    });

    expect(result.status).toBe('error');
    expect(result.issues.map((issue) => issue.code)).toContain('lead_contact_ask_forbidden');
  });

  it('repairs forbidden contact pressure without changing the rest of the answer', () => {
    const verification = verifyPostAnswer({
      answer: 'Подбор по генератору продолжим по карточкам. Оставьте телефон и имя, я передам заявку.',
      factClaimPlanner,
      leadStateMachine: {
        ...leadStateMachine,
        state: 'not_allowed',
        nextAction: 'do_not_ask_contact',
        leadPolicy: 'forbidden'
      },
      cardManifest
    });
    const repaired = repairAnswerForPostAnswerVerification({
      answer: 'Подбор по генератору продолжим по карточкам. Оставьте телефон и имя, я передам заявку.',
      verification
    });
    const after = verifyPostAnswer({
      answer: repaired,
      factClaimPlanner,
      leadStateMachine: {
        ...leadStateMachine,
        state: 'not_allowed',
        nextAction: 'do_not_ask_contact',
        leadPolicy: 'forbidden'
      },
      cardManifest
    });

    expect(repaired).toContain('Подбор по генератору');
    expect(repaired).not.toContain('телефон');
    expect(after.status).toBe('pass');
  });

  it('classifies forbidden contact pressure as deterministic-repairable', () => {
    const verification = verifyPostAnswer({
      answer: 'Leave your phone number and name, I will create the request.',
      factClaimPlanner,
      leadStateMachine: {
        ...leadStateMachine,
        state: 'not_allowed',
        nextAction: 'do_not_ask_contact',
        leadPolicy: 'forbidden'
      },
      cardManifest
    });

    expect(classifyPostAnswerRecovery(verification)).toMatchObject({
      repairableIssues: ['lead_contact_ask_forbidden'],
      unrecoverableIssues: [],
      canAttemptDeterministicRepair: true,
      requiresRegenerationOrTooling: false
    });
  });

  it('blocks repeated contact requests after the lead was already created', () => {
    const createdLeadState: LeadStateMachine = {
      ...leadStateMachine,
      state: 'created',
      nextAction: 'confirm_created_lead',
      leadPolicy: 'required_now',
      hasContactInTurn: true,
      leadRequested: true,
      leadCreated: true
    };
    const verification = verifyPostAnswer({
      answer: 'Contact received. Leave your phone number again so I can create the request.',
      factClaimPlanner,
      leadStateMachine: createdLeadState,
      cardManifest
    });
    const repaired = repairAnswerForPostAnswerVerification({
      answer: 'Contact received. Leave your phone number again so I can create the request.',
      verification
    });

    expect(verification.status).toBe('error');
    expect(verification.issues.map((issue) => issue.code)).toContain('lead_contact_ask_after_created');
    expect(classifyPostAnswerRecovery(verification)).toMatchObject({
      repairableIssues: ['lead_contact_ask_after_created'],
      unrecoverableIssues: [],
      canAttemptDeterministicRepair: true,
      requiresRegenerationOrTooling: false
    });
    expect(repaired).toBe('Contact received.');
  });

  it('flags unverified live stock, delivery, discount, or exact commercial promises', () => {
    const result = verifyPostAnswer({
      answer: 'Товар есть в наличии, доставка будет бесплатной.',
      factClaimPlanner: {
        ...factClaimPlanner,
        factPolicy: 'specialist_required',
        forbiddenClaims: ['do_not_promise_live_stock_delivery_discount_or_exact_terms'],
        risk: 'high'
      },
      leadStateMachine,
      cardManifest
    });

    expect(result.status).toBe('error');
    expect(result.issues.map((issue) => issue.code)).toContain('unverified_specialist_fact_promise');
  });

  it('repairs unverified commercial promises into verification wording', () => {
    const planner = {
      ...factClaimPlanner,
      factPolicy: 'specialist_required' as const,
      forbiddenClaims: ['do_not_promise_live_stock_delivery_discount_or_exact_terms'],
      risk: 'high' as const
    };
    const verification = verifyPostAnswer({
      answer: 'Товар есть в наличии, доставка будет бесплатной.',
      factClaimPlanner: planner,
      leadStateMachine,
      cardManifest
    });
    const repaired = repairAnswerForPostAnswerVerification({
      answer: 'Товар есть в наличии, доставка будет бесплатной.',
      verification
    });
    const after = verifyPostAnswer({
      answer: repaired,
      factClaimPlanner: planner,
      leadStateMachine,
      cardManifest
    });

    expect(repaired).toContain('сверю');
    expect(repaired).toContain('доставки');
    expect(after.status).toBe('pass');
  });

  it('flags third-person manager wording so LLM can rewrite it in first person', () => {
    const result = verifyPostAnswer({
      answer: 'Точное наличие и доставку по Азову подтвердит менеджер или логистика после заявки.',
      factClaimPlanner,
      leadStateMachine,
      cardManifest
    });

    expect(result.status).toBe('error');
    expect(result.issues.map((issue) => issue.code)).toContain('third_person_manager_role_handoff');
    expect(result.checkedPolicies).toContain('ai_manager_voice_policy');
  });

  it('keeps a deterministic safety repair for third-person manager wording only as fallback', () => {
    const verification = verifyPostAnswer({
      answer: 'Наличие и доставку уточнит менеджер/логистика.',
      factClaimPlanner,
      leadStateMachine,
      cardManifest
    });
    const repaired = repairAnswerForPostAnswerVerification({
      answer: 'Наличие и доставку уточнит менеджер/логистика.',
      verification
    });
    const after = verifyPostAnswer({
      answer: repaired,
      factClaimPlanner,
      leadStateMachine,
      cardManifest
    });

    expect(repaired).toMatch(/посчитаю|сверю/iu);
    expect(repaired).not.toMatch(/менеджер/iu);
    expect(after.status).toBe('pass');
  });

  it('fails the final payload when a visible card is not allowed by product evidence registry', () => {
    const result = verifyPostAnswer({
      answer: 'Вот основной вариант — TSS SGG 5000.',
      factClaimPlanner,
      leadStateMachine,
      cardManifest: {
        ...cardManifest,
        visibleProductIds: ['bad-card'],
        items: [{
          productId: 'bad-card',
          name: 'TSS SGG 5000',
          rank: 1,
          visible: true,
          role: 'primary',
          constraintStatus: 'satisfies_hard_constraints',
          violations: []
        }]
      },
      productEvidenceRegistry: {
        version: 1,
        visibleProductIds: [],
        hiddenProductIds: ['bad-card'],
        rejectedProductIds: ['bad-card'],
        allowedProductIdsForText: ['bad-card'],
        warnings: [],
        items: [{
          productId: 'bad-card',
          name: 'TSS SGG 5000',
          source: 'catalog',
          role: 'rejected',
          allowedInAnswerText: true,
          allowedAsVisibleCard: false,
          rejectionReason: 'violates hard requirement',
          constraintStatus: 'violates_hard_constraints',
          evidence: ['Rejected by card contract']
        }]
      }
    });

    expect(result.status).toBe('error');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'final_payload_disallowed_visible_card' })
    ]));
    expect(result.checkedPolicies).toContain('final_payload_atomic_validation');
  });

  it('uses claim evidence contract to block unsupported commercial claims even without heuristic warnings', () => {
    const result = verifyPostAnswer({
      answer: 'Товар есть в наличии.',
      factClaimPlanner,
      leadStateMachine,
      cardManifest,
      factClaimAudit: {
        version: 1,
        claims: [{
          kind: 'availability',
          text: 'Товар есть в наличии.',
          requiredSource: 'specialist',
          groundingStatus: 'ungrounded',
          matchedProductIds: []
        }],
        warnings: []
      }
    });

    expect(result.status).toBe('error');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'claim_evidence_contract:stock_claim_requires_live_warehouse_or_manager_evidence',
        severity: 'error'
      })
    ]));
    expect(result.checkedPolicies).toContain('claim_evidence_contract');
  });

  it('elevates ungrounded fact claim audit warnings into verification errors', () => {
    const result = verifyPostAnswer({
      answer: 'Эта модель актуальна в текущей линейке производителя.',
      factClaimPlanner,
      leadStateMachine,
      cardManifest,
      factClaimAudit: {
        version: 1,
        claims: [{
          kind: 'current_lineup',
          text: 'Эта модель актуальна в текущей линейке производителя.',
          requiredSource: 'web',
          groundingStatus: 'ungrounded',
          matchedProductIds: [],
          warning: 'current_lineup_claim_without_web_policy'
        }],
        warnings: ['current_lineup_claim_without_web_policy']
      }
    });

    expect(result.status).toBe('error');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'fact_claim_audit:current_lineup_claim_without_web_policy',
        severity: 'error'
      })
    ]));
  });

  it('classifies current-lineup claims as unrecoverable without web/regeneration', () => {
    const verification = verifyPostAnswer({
      answer: 'Р­С‚Р° РјРѕРґРµР»СЊ Р°РєС‚СѓР°Р»СЊРЅР° РІ С‚РµРєСѓС‰РµР№ Р»РёРЅРµР№РєРµ РїСЂРѕРёР·РІРѕРґРёС‚РµР»СЏ.',
      factClaimPlanner,
      leadStateMachine,
      cardManifest,
      factClaimAudit: {
        version: 1,
        claims: [{
          kind: 'current_lineup',
          text: 'Р­С‚Р° РјРѕРґРµР»СЊ Р°РєС‚СѓР°Р»СЊРЅР° РІ С‚РµРєСѓС‰РµР№ Р»РёРЅРµР№РєРµ РїСЂРѕРёР·РІРѕРґРёС‚РµР»СЏ.',
          requiredSource: 'web',
          groundingStatus: 'ungrounded',
          matchedProductIds: [],
          warning: 'current_lineup_claim_without_web_policy'
        }],
        warnings: ['current_lineup_claim_without_web_policy']
      }
    });

    const recovery = classifyPostAnswerRecovery(verification);
    expect(recovery.repairableIssues).toEqual([]);
    expect(recovery.unrecoverableIssues).toEqual(['fact_claim_audit:current_lineup_claim_without_web_policy']);
    expect(recovery.canAttemptDeterministicRepair).toBe(false);
    expect(recovery.requiresRegenerationOrTooling).toBe(true);
    expect(repairAnswerForPostAnswerVerification({
      answer: 'Р­С‚Р° РјРѕРґРµР»СЊ Р°РєС‚СѓР°Р»СЊРЅР° РІ С‚РµРєСѓС‰РµР№ Р»РёРЅРµР№РєРµ РїСЂРѕРёР·РІРѕРґРёС‚РµР»СЏ.',
      verification
    })).toBe('Р­С‚Р° РјРѕРґРµР»СЊ Р°РєС‚СѓР°Р»СЊРЅР° РІ С‚РµРєСѓС‰РµР№ Р»РёРЅРµР№РєРµ РїСЂРѕРёР·РІРѕРґРёС‚РµР»СЏ.');
  });

  it('flags answers that name a visible card with hard-constraint violations', () => {
    const result = verifyPostAnswer({
      answer: 'Лучше взять Other DG 8000 diesel generator 380 V.',
      factClaimPlanner: {
        ...factClaimPlanner,
        warnings: ['visible_card_constraint_violation:other-8']
      },
      leadStateMachine,
      cardManifest: {
        ...cardManifest,
        visibleProductIds: ['other-8'],
        items: [{
          productId: 'other-8',
          name: 'Other DG 8000 diesel generator 380 V',
          rank: 1,
          visible: true,
          role: 'primary',
          constraintStatus: 'violates_hard_constraints',
          violations: ['brandConstraint:TSS']
        }],
        warnings: ['visible_card_constraint_violation:other-8']
      }
    });

    expect(result.status).toBe('error');
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'violating_card_named_as_recommendation',
      'visible_card_constraint_violation:other-8'
    ]));
  });

  it('flags product names denied by the product evidence registry', () => {
    const result = verifyPostAnswer({
      answer: 'The best option is Other 2 kW generator.',
      factClaimPlanner,
      leadStateMachine,
      cardManifest,
      productEvidenceRegistry
    });

    expect(result.status).toBe('error');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'disallowed_product_named_in_answer',
        severity: 'error'
      })
    ]));
    expect(result.checkedPolicies).toContain('product_evidence_registry');
  });
});
