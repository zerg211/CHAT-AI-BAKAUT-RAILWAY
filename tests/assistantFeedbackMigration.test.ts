import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('assistant feedback event migration', () => {
  it('creates a queryable negative-feedback queue with evidence and export state', async () => {
    const schema = await fs.readFile(
      path.join(process.cwd(), 'sql', '013_assistant_feedback_events.sql'),
      'utf8'
    );

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS assistant_feedback_events');
    expect(schema).toContain("rating IN ('negative', 'wrong_cards')");
    expect(schema).toContain('turn_id uuid NOT NULL REFERENCES conversation_turns(id)');
    expect(schema).toContain('policy_evidence jsonb NOT NULL');
    expect(schema).toContain('model_evidence jsonb NOT NULL');
    expect(schema).toContain('tool_evidence jsonb NOT NULL');
    expect(schema).toContain('card_evidence jsonb NOT NULL');
    expect(schema).toContain('exported_fixture jsonb');
    expect(schema).toContain('UNIQUE(assistant_message_id, rating)');
    expect(schema).toContain('assistant_feedback_events_queue_idx');
    expect(schema).toContain('assistant_feedback_events_policy_version_idx');
    expect(schema).toContain('assistant_feedback_events_answer_model_idx');
    expect(schema).toContain('assistant_feedback_events_tool_evidence_idx');
    expect(schema).toContain('assistant_feedback_events_card_evidence_idx');
  });
});
