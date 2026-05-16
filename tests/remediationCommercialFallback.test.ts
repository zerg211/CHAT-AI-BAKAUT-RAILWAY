import { describe, expect, it } from 'vitest';
import { assistantTestHooks } from '../src/ai/assistant.js';
import { auditAnswerFactClaims, buildFactClaimPlanner } from '../src/ai/factClaimPlanner.js';
import type { ExecutionContract, RequirementLedger } from '../src/shared/types.js';

const executionContract: ExecutionContract = {
  version: 1,
  source: 'agent_turn_contract',
  answerTask: 'lead_handoff',
  taskType: 'pure_delivery',
  catalogPolicy: 'none',
  cardsPolicy: 'none',
  leadPolicy: 'forbidden',
  factPolicy: 'specialist_required',
  activeRequirementIds: [],
  postconditions: [],
  warnings: []
};

const requirementLedger: RequirementLedger = {
  version: 1,
  activeRequirementIds: [],
  primaryRequirementIds: [],
  alternativeMode: 'none',
  items: [],
  hardConstraintKeys: [],
  warnings: []
};

describe('commercial remediation fallback', () => {
  it('answers delivery, discount, and rough bundle total without exposing a generic failure', () => {
    const answer = assistantTestHooks.deterministicCommercialHandoffFallback({
      cards: [
        {
          id: 'gen-5',
          name: 'Генератор бензиновый SUMEC SU7700 5 кВт',
          category: 'Бензиновые генераторы',
          price: 42490,
          currency: 'RUB',
          specs: {},
          reasons: [],
          caveats: []
        },
        {
          id: 'plate-50',
          name: 'Виброплита STEM Techno SPC 152E 50 кг',
          category: 'Виброплиты',
          price: 35500,
          currency: 'RUB',
          specs: {},
          reasons: [],
          caveats: []
        }
      ],
      selectionResult: {
        visibleProducts: [],
        matchedProducts: [],
        missingQuestions: [],
        confidence: 0.8
      },
      latestUserMessage: 'А доставка и скидка есть? И примерно можно понять порядок суммы?',
      contract: {
        answerTask: 'lead_handoff',
        taskType: 'pure_delivery',
        catalogAction: 'none',
        commercialAction: 'explain_manager_required',
        productCardsPolicy: 'none',
        mustAnswerNow: [],
        activeNeeds: [],
        currentFocus: 'commercial',
        cardsRole: 'none',
        leadAllowed: false,
        leadAllowedReason: 'buyer asked commercial terms but refused contact pressure',
        errorRecoveryPriority: 'answer commercial terms safely',
        validatorWarnings: []
      }
    } as any);

    expect(answer).toContain('Доставка есть');
    expect(answer).toContain('логистику');
    expect(answer).toContain('Скидку');
    expect(answer).toContain('примерно от');
    expect(answer).not.toMatch(/не смог|повторите|телефон|номер/iu);
  });

  it('does not append stock verification to a non-commercial selection answer after planner overclassification', () => {
    const answer = 'Пока это предварительный расчет: смотрю генератор около 4 кВт по номиналу.';
    const result = assistantTestHooks.ensureCommercialManagerVerification(answer, {
      answerTask: 'product_selection',
      taskType: 'product_selection_with_availability',
      commercialAction: 'explain_manager_required',
      currentFocus: 'catalog_selection'
    } as any);

    expect(result).toBe(answer);
  });

  it('does not treat verified live stock wording as a current manufacturer lineup claim', () => {
    const audit = auditAnswerFactClaims({
      answer: 'Актуальный склад и возможность отгрузки сверю перед оформлением.',
      factClaimPlanner: buildFactClaimPlanner({ executionContract, requirementLedger })
    });

    expect(audit.warnings).not.toContain('current_lineup_claim_without_web_policy');
    expect(audit.warnings).not.toContain('availability_claim_without_specialist_verification_wording');
  });
});
