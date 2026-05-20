import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('assistant legacy writer guard integration', () => {
  it('guards old user-visible fast and deterministic answer writers', () => {
    const source = readFileSync('src/ai/assistant.ts', 'utf8');

    expect(source).not.toContain("legacyAnswerWriterAllowed('fast_commercial_contact_confirmation')");
    expect(source).not.toContain("legacyAnswerWriterAllowed('fast_catalog_selection')");
    expect(source).toContain("const llmFastCommercialHandoff = llmFastTurnDecision?.route === 'commercial_handoff'");
    expect(source).toContain("const llmFastCatalogSelection = llmFastTurnDecision?.route === 'catalog_selection'");
    expect(source).toContain("answerMode: 'llm_fast_commercial_handoff'");
    expect(source).toContain("answerMode: 'llm_fast_catalog_selection'");
    expect(source).toContain("legacyAnswerWriterAllowed('fast_technical_orientation')");
    expect(source).toContain("legacyAnswerWriterAllowed('deterministic_answer_generation_fallback')");
    expect(source).toContain("legacyAnswerWriterAllowed('deterministic_turn_recovery')");
  });
});
