import type { ToolResult } from './agentManagerContracts.js';
import { type ExtractedContact, hasLeadContact } from './contactExtraction.js';

const contactRequestStarts = ['оставьте', 'оставь'];
const contactRequestTargets = ['телефон', 'номер', 'контакт', 'имя'];

function lowerRu(text: string) {
  return text.toLocaleLowerCase('ru-RU');
}

function nextLineBreak(text: string, start: number) {
  const index = text.indexOf('\n', start);
  return index >= 0 ? index : text.length;
}

function earliestContactRequestStart(lowerText: string, start: number) {
  let best: { index: number; phrase: string } | null = null;
  for (const phrase of contactRequestStarts) {
    const index = lowerText.indexOf(phrase, start);
    if (index < 0) continue;
    if (!best || index < best.index || (index === best.index && phrase.length > best.phrase.length)) {
      best = { index, phrase };
    }
  }
  return best;
}

function containsContactRequestTarget(text: string) {
  return contactRequestTargets.some((target) => text.includes(target));
}

export function answerRequestsContactData(answerText: string) {
  const lower = lowerRu(answerText);
  let cursor = 0;
  while (cursor < lower.length) {
    const start = earliestContactRequestStart(lower, cursor);
    if (!start) return false;

    const segmentStart = start.index + start.phrase.length;
    const segmentEnd = Math.min(segmentStart + 40, nextLineBreak(lower, segmentStart));
    if (containsContactRequestTarget(lower.slice(segmentStart, segmentEnd))) return true;

    cursor = start.index + 1;
  }
  return false;
}

function sentenceEndIndex(text: string, start: number) {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') return { end: index, includeTerminator: false };
    if (char === '.' || char === '!' || char === '?') return { end: index, includeTerminator: true };
  }
  return { end: text.length, includeTerminator: false };
}

export function stripContactRequestSentence(answerText: string) {
  const lower = lowerRu(answerText);
  let output = '';
  let cursor = 0;
  while (cursor < answerText.length) {
    const start = earliestContactRequestStart(lower, cursor);
    if (!start) {
      output += answerText.slice(cursor);
      break;
    }

    const sentenceEnd = sentenceEndIndex(answerText, start.index);
    const removalEnd = sentenceEnd.includeTerminator ? sentenceEnd.end + 1 : sentenceEnd.end;
    const segment = lower.slice(start.index, removalEnd);
    if (!containsContactRequestTarget(segment)) {
      output += answerText.slice(cursor, start.index + start.phrase.length);
      cursor = start.index + start.phrase.length;
      continue;
    }

    output += answerText.slice(cursor, start.index);
    cursor = removalEnd;
  }
  return output.trim();
}

export function leadCaptureMissingContact(toolResults: ToolResult[]) {
  return toolResults.some((result) =>
    result.tool === 'lead.capture' &&
    result.status !== 'ok' &&
    result.warnings.some((warning) => warning === 'lead_contact_missing' || warning === 'lead_name_missing')
  );
}

export function leadCaptureMissingName(toolResults: ToolResult[]) {
  return toolResults.some((result) =>
    result.tool === 'lead.capture' &&
    result.status !== 'ok' &&
    result.warnings.includes('lead_name_missing')
  );
}

export function leadCaptureRepairText(input: {
  contact: ExtractedContact;
  toolResults: ToolResult[];
  answerText?: string;
  preserveAnswer?: boolean;
}) {
  const baseAnswer = input.preserveAnswer === false
    ? ''
    : stripContactRequestSentence(input.answerText ?? '');
  const append = (suffix: string) => baseAnswer ? `${baseAnswer}\n\n${suffix}` : suffix;
  if (hasLeadContact(input.contact) && leadCaptureMissingName(input.toolResults)) {
    return append('Телефон вижу. Напишите, пожалуйста, имя и как удобнее получить результат — сообщением или звонком. После этого смогу оформить запрос.');
  }
  return append('Оставьте, пожалуйста, имя и номер телефона и скажите, как удобнее получить результат — сообщением или звонком. После этого смогу оформить уточнение.');
}
