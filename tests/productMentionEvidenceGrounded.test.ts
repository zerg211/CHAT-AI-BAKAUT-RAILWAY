import { describe, expect, it } from 'vitest';
import { productMentionEvidenceGrounded, validateAgentSemanticDecision } from '../src/ai/agentManagerOrchestrator.js';
import { AgentSemanticDecisionSchema } from '../src/ai/agentManagerContracts.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';
import type { Message } from '../src/shared/types.js';

describe('buyer product mention evidence', () => {
  it('accepts the same quoted model in different casing but not a neighboring model', () => {
    expect(productMentionEvidenceGrounded('SUNREKA G7000iS', 'А у sunreka g7000is есть ручной запуск?')).toBe(true);
    expect(productMentionEvidenceGrounded('SUNREKA G8000iS', 'А у sunreka g7000is есть ручной запуск?')).toBe(false);
    expect(productMentionEvidenceGrounded('', 'Как запустить?')).toBe(false);
  });
  it('uses grounded casing consistently in the semantic decision validator', () => {
    const decision = AgentSemanticDecisionSchema.parse({
      ledgerDelta: { rationale: 'Exact model question', events: [] },
      intent: { userMessageSummary: 'Exact model question', dialogueUnderstanding: 'User named a model',
        nextStepRationale: 'Read the exact product', requiresTools: false, toolRequests: [],
        productMentions: [{ name: 'SUNREKA G7000iS', evidence: 'SUNREKA G7000iS', role: 'target_product', productClass: 'generator' }] }
    });
    const result = validateAgentSemanticDecision({ decision, previousLedgerState: reduceDialogueLedger([]),
      sessionId: '11111111-1111-4111-8111-111111111111', turnId: '22222222-2222-4222-8222-222222222222',
      userMessage: 'А у sunreka g7000is есть ручной запуск?' });
    expect(result.issues).not.toContain('product_mention_evidence_not_in_current_message:0');
  });
});

describe('resolved historical product targets', () => {
  const name = 'ТСС SGG 5000N, артикул 060007';
  const messageId = 'previous-technical-answer';
  const userMessage = 'Бумажной инструкции у меня сейчас нет. Посмотрите, пожалуйста, руководство производителя.';
  const history: Message[] = [{
    id: messageId, sessionId: 'session', role: 'assistant', createdAt: '2026-09-05T15:00:00Z',
    content: 'ТСС SGG 5000N запускается ручным стартером.',
    metadata: { productCards: [], intentContract: { productMentions: [
      { name, role: 'target_product', productClass: 'generator', evidence: name }
    ] } }
  }];
  function decision() {
    return AgentSemanticDecisionSchema.parse({
      ledgerDelta: { rationale: 'Continue the exact technical question.', events: [] },
      intent: {
        userMessageSummary: 'Check the manual.', dialogueUnderstanding: 'The buyer refers to the same generator.',
        nextStepRationale: 'Read the exact manufacturer manual.', requiresTools: true,
        grounding: { taskType: 'technical_answer', responseMode: 'answer', sourcePolicy: 'web_required',
          webPurpose: 'manual_or_service', webRequirement: 'buyer_requested', buyerRequestedWeb: true,
          catalogRequirement: 'none', requiredToolKinds: ['web.researchProductFacts'],
          technicalAttributes: ['oil_level_check'], buyerQuestion: userMessage, rationale: 'Explicit manual request.' },
        selectionPolicy: { canonicalProductClass: 'generator', targetProductClass: 'generator',
          selectionGoal: 'final_fit', needAction: 'continue', alternativePolicy: 'exact_only',
          powerSource: 'fuel', phase: 'any', requirements: [], rankingObjectives: [],
          reusePreviousCards: false, maxCards: 0, rationale: 'The same exact model.' },
        productMentions: [{ name, role: 'target_product', productClass: 'generator',
          evidence: 'руководство производителя', sourceMessageId: messageId }],
        toolRequests: [{ id: 'manual', tool: 'web.researchProductFacts', required: true,
          rationale: 'Check exact model.', args: { query: 'Руководство ТСС SGG 5000N 060007',
            canonicalProductIntent: 'generator', productIntent: 'generator', productNames: [name] } }]
      }
    });
  }
  function validate(value: ReturnType<typeof decision>, messages = history) {
    return validateAgentSemanticDecision({ decision: value, history: messages,
      previousLedgerState: reduceDialogueLedger([]), sessionId: 'session', turnId: 'turn', userMessage });
  }

  it('binds a current reference phrase to the exact earlier typed target even without product cards', () => {
    expect(validate(decision()).issues).toEqual([]);
  });

  it('keeps legacy mentions without the new field compatible and retains the current-evidence guard', () => {
    const value = decision();
    delete value.intent.productMentions![0]!.sourceMessageId;
    expect(validate(value).issues).toEqual([]);
    const fabricatedEvidence = decision();
    fabricatedEvidence.intent.productMentions![0]!.evidence = 'a quote absent from the buyer message';
    expect(validate(fabricatedEvidence).issues).toContain('product_mention_evidence_not_in_current_message:0');
  });

  it('allows a newly named current model with sourceMessageId null', () => {
    const value = decision();
    value.intent.productMentions![0]!.sourceMessageId = null;
    value.intent.productMentions![0]!.evidence = name;
    expect(validateAgentSemanticDecision({ decision: value, history,
      previousLedgerState: reduceDialogueLedger([]), sessionId: 'session', turnId: 'turn',
      userMessage: `Посмотрите руководство для ${name}` }).issues).toEqual([]);
  });

  it.each(['other-message', null])('rejects an ungrounded history reference %s', (sourceMessageId) => {
    const value = decision();
    value.intent.productMentions![0]!.sourceMessageId = sourceMessageId;
    expect(validate(value).issues).toContain('product_mention_history_reference_unverified:0');
  });

  it('rejects a different model or a context-load device as the historical target', () => {
    const value = decision();
    value.intent.productMentions![0]!.name = 'ТСС SGG 5000NE';
    expect(validate(value).issues).toContain('product_mention_history_reference_unverified:0');
    const contextHistory = structuredClone(history);
    (contextHistory[0]!.metadata.intentContract as any).productMentions[0].role = 'context_load_device';
    expect(validate(decision(), contextHistory).issues).toContain('product_mention_history_reference_unverified:0');
  });

  it('rejects losing the resolved exact target during repair even if its name remains in the free-text query', () => {
    const value = decision();
    value.intent.productMentions = [];
    const request = value.intent.toolRequests.find((item) => item.tool === 'web.researchProductFacts')!;
    request.args.productNames = [];
    expect(validate(value).issues).toContain('exact_product_research_target_missing:manual');
  });

  it('does not assign a past model to a newly general technical question', () => {
    const value = decision();
    value.intent.selectionPolicy!.alternativePolicy = 'unknown';
    value.intent.productMentions = [];
    const request = value.intent.toolRequests.find((item) => item.tool === 'web.researchProductFacts')!;
    request.args.productNames = [];
    request.args.query = 'Общие правила проверки уровня масла';
    expect(validate(value).issues).not.toContain('exact_product_research_target_missing:manual');
  });
});
