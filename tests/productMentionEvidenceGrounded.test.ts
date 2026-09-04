import { describe, expect, it } from 'vitest';
import { productMentionEvidenceGrounded, validateAgentSemanticDecision } from '../src/ai/agentManagerOrchestrator.js';
import { AgentSemanticDecisionSchema } from '../src/ai/agentManagerContracts.js';
import { reduceDialogueLedger } from '../src/ai/dialogueLedgerReducer.js';

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
