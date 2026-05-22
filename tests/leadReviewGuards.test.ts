import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import {
  answerRequestsContactData,
  leadCaptureMissingContact,
  leadCaptureMissingName,
  leadCaptureRepairText,
  stripContactRequestSentence
} from '../src/ai/leadReviewGuards.js';

function leadResult(warnings: string[]): ToolResult {
  return {
    requestId: 'lead.capture:test',
    tool: 'lead.capture',
    status: 'not_found',
    payload: {},
    warnings
  };
}

describe('lead review guards', () => {
  it('detects a repeated contact request after contact was already provided', () => {
    expect(answerRequestsContactData('Оставьте телефон в форме, и я передам вопрос менеджеру.')).toBe(true);
    expect(answerRequestsContactData('Телефон получил, теперь нужно только имя.')).toBe(false);
  });

  it('strips repeated contact request sentences without changing other text', () => {
    const answer = 'Сейчас проверю варианты. Оставьте телефон в форме, и я передам вопрос менеджеру. По моделям подскажу отдельно.';

    expect(stripContactRequestSentence(answer)).toBe('Сейчас проверю варианты.  По моделям подскажу отдельно.');
  });

  it('classifies missing lead contact and missing lead name tool results', () => {
    const missingName = leadResult(['lead_name_missing']);

    expect(leadCaptureMissingContact([missingName])).toBe(true);
    expect(leadCaptureMissingName([missingName])).toBe(true);
  });

  it('returns the missing-name repair when phone is present but name is absent', () => {
    const text = leadCaptureRepairText({
      contact: { phone: '+7 900 000-00-11' },
      toolResults: [leadResult(['lead_name_missing'])]
    });

    expect(text).toContain('Телефон получил');
    expect(text).toContain('Напишите, пожалуйста, имя');
  });
});
