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
    expect(answerRequestsContactData('Напишите ваш номер телефона, и я сообщу результат.')).toBe(true);
    expect(answerRequestsContactData('Укажите телефон для обратной связи.')).toBe(true);
    expect(answerRequestsContactData('Можете отправить номер телефона?')).toBe(true);
    expect(answerRequestsContactData('Please send your phone number.')).toBe(true);
    expect(answerRequestsContactData('Не отправляйте номер телефона в открытом чате.')).toBe(false);
    expect(answerRequestsContactData('Телефон получил, теперь нужно только имя.')).toBe(false);
  });

  it.each([
    'Напишите номер модели генератора, чтобы я проверил инструкцию.',
    'Укажите артикул и имя модели.',
    'Tell me the model name and serial number.',
    'Напишите имя производителя.',
    'Укажите имя менеджера.',
    'Сообщите номер договора.',
    'Пришлите номер счёта.'
  ])('does not confuse a technical product identifier with contact data: %s', (answer) => {
    expect(answerRequestsContactData(answer)).toBe(false);
    expect(stripContactRequestSentence(answer)).toBe(answer);
  });

  it('recognizes the approved result-follow-up wording without treating every bare number as contact data', () => {
    const approved = 'Оставьте номер и скажите, как удобнее связаться — написать или позвонить?';
    expect(answerRequestsContactData(approved)).toBe(true);
    expect(answerRequestsContactData('Укажите ваш номер.')).toBe(true);
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
    const base = 'По каталожным данным модель выглядит подходящей, но совместимость разъёма пока не подтверждена.';
    const text = leadCaptureRepairText({
      contact: { phone: '+7 900 000-00-11' },
      toolResults: [leadResult(['lead_name_missing'])],
      answerText: base
    });

    expect(text).toContain(base);
    expect(text).toContain('Телефон вижу');
    expect(text).toContain('Напишите, пожалуйста, имя');
    expect(text).toContain('сообщением или звонком');
    expect(text).not.toContain('передам');
  });
});

describe('lead review fail-closed repair', () => {
  it('preserves the useful answer and replaces only an unsafe contact sentence', () => {
    const base = fromEscaped('\\u0418\\u0437 \\u043a\\u0430\\u0442\\u0430\\u043b\\u043e\\u0433\\u0430 \\u043f\\u043e\\u0434\\u0445\\u043e\\u0434\\u0438\\u0442 APS 800: \\u044d\\u0442\\u043e \\u0430\\u043a\\u043a\\u0443\\u043c\\u0443\\u043b\\u044f\\u0442\\u043e\\u0440\\u043d\\u0430\\u044f \\u0441\\u0442\\u0430\\u043d\\u0446\\u0438\\u044f \\u043d\\u0430 220 \\u0412.');
    const removedContactSentence = fromEscaped('\\u041e\\u0441\\u0442\\u0430\\u0432\\u044c\\u0442\\u0435 \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d \\u0432 \\u0444\\u043e\\u0440\\u043c\\u0435.');
    const text = leadCaptureRepairText({
      contact: {},
      toolResults: [leadResult(['lead_contact_missing'])],
      answerText: `${base} ${removedContactSentence}`
    });

    expect(text).toContain(base);
    expect(text).toContain('Оставьте, пожалуйста, имя и номер телефона');
    expect(text).toContain('сообщением или звонком');
    expect(text).not.toContain(removedContactSentence);
    expect(text).not.toContain('передам');
  });
});
