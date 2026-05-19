import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('assistant legacy writer guard integration', () => {
  it('guards old user-visible fast and deterministic answer writers', () => {
    const source = readFileSync('src/ai/assistant.ts', 'utf8');

    expect(source).toContain("legacyAnswerWriterAllowed('fast_commercial_contact_confirmation')");
    expect(source).toContain("legacyAnswerWriterAllowed('fast_catalog_selection')");
    expect(source).toContain("legacyAnswerWriterAllowed('fast_technical_orientation')");
    expect(source).toContain("legacyAnswerWriterAllowed('deterministic_answer_generation_fallback')");
    expect(source).toContain("legacyAnswerWriterAllowed('proactive_commercial_answer')");
    expect(source).toContain("legacyAnswerWriterAllowed('proactive_catalog_selection_answer')");
    expect(source).toContain("legacyAnswerWriterAllowed('lead_confirmation_answer')");
    expect(source).toContain("legacyAnswerWriterAllowed('deterministic_turn_recovery')");
  });
});
