import { describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/ai/agentManagerContracts.js';
import {
  answerRequestsContactData,
  leadCaptureMissingContact,
  leadCaptureMissingName,
  leadCaptureRepairText,
  stripContactRequestSentence
} from '../src/ai/leadReviewGuards.js';

const fromEscaped = (value: string) => JSON.parse(`"${value}"`) as string;

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

describe('lead review repair preservation', () => {
  it('preserves the useful product answer when adding a safe form handoff', () => {
    const base = fromEscaped('\\u0418\\u0437 \\u043a\\u0430\\u0442\\u0430\\u043b\\u043e\\u0433\\u0430 \\u043f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 APS 800: \\u044d\\u0442\\u043e \\u0430\\u043a\\u043a\\u0443\\u043c\\u0443\\u043b\\u044f\\u0442\\u043e\\u0440\\u043d\\u0430\\u044f \\u0441\\u0442\\u0430\\u043d\\u0446\\u0438\\u044f \\u043d\\u0430 220 \\u0412.');
    const removedContactSentence = fromEscaped('\\u041e\\u0441\\u0442\\u0430\\u0432\\u044c\\u0442\\u0435 \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d \\u0432 \\u0444\\u043e\\u0440\\u043c\\u0435.');
    const text = leadCaptureRepairText({
      contact: {},
      toolResults: [leadResult(['lead_contact_missing'])],
      answerText: `${base} ${removedContactSentence}`
    });

    expect(text).toContain(base);
    expect(text).toContain(fromEscaped('\\u0427\\u0442\\u043e\\u0431\\u044b \\u043f\\u0440\\u043e\\u0432\\u0435\\u0440\\u0438\\u0442\\u044c \\u043d\\u0430\\u043b\\u0438\\u0447\\u0438\\u0435'));
    expect(text).not.toContain(removedContactSentence);
  });
});
