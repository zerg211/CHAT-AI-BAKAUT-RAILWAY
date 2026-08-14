import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

describe('agent manager primary answer path', () => {
  it('has no deterministic terminal or reviewer replacement answer path', async () => {
    const orchestrator = await source('../src/ai/agentManagerOrchestrator.ts');
    const contracts = await source('../src/ai/agentManagerContracts.ts');
    const config = await source('../src/config.ts');
    const policyTargets = await source('../src/ai/policy/policyRuleTypes.ts');

    expect(orchestrator).not.toContain('completeTerminalTurn');
    expect(orchestrator).not.toContain('terminalCatalogRecovery');
    expect(orchestrator).not.toContain('enforceReviewerPreliminaryCandidateRecovery');
    expect(orchestrator).not.toContain('terminal_response_committed');
    expect(orchestrator).not.toContain('degraded_terminal');
    expect(orchestrator).not.toContain('this.model.reviewAnswer(');
    expect(orchestrator).not.toContain('revisedAnswerText.trim()');
    expect(contracts).not.toContain('rewrite_required');
    expect(config).not.toContain('AI_MANAGER_REVIEW_MODE');
    expect(policyTargets).not.toContain("'reviewer'");
    expect(orchestrator).toContain('answerContractFormatForEvidenceSources');
    expect(orchestrator).toContain('enum: allowedSourceIds');
  });

  it('does not perform an automatic semantic rerun after initial generation fails', async () => {
    const route = await source('../src/routes/chat.ts');
    const recoverCallCount = route.split('assistant.recoverTurn(').length - 1;

    // One call belongs to the explicit exact-turn continuation endpoint.
    expect(recoverCallCount).toBe(1);
    expect(route).not.toContain('semanticRecoveryAttempted');
  });

  it('requires structured LLM authority for visible card selection', async () => {
    const cardSelection = await source('../src/ai/agentManagerCardSelection.ts');
    const orchestrator = await source('../src/ai/agentManagerOrchestrator.ts');

    expect(cardSelection).not.toContain('legacy_fallback');
    expect(orchestrator).not.toContain('useLegacySemanticRanking');
  });

  it('does not expose obsolete fallback diagnostics in the widget contract', async () => {
    const sharedTypes = await source('../src/shared/types.ts');
    const client = await source('../src/client/main.tsx');

    expect(sharedTypes).not.toContain('AiFallbackDiagnostic');
    expect(sharedTypes).not.toContain('answerGenerationFallback');
    expect(client).not.toContain('AI fallback');
    expect(client).not.toContain('answer fallback');
  });
});
