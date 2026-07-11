import type { ToolResult } from './agentManagerContracts.js';
import { type ExtractedContact, hasLeadContact } from './contactExtraction.js';

const fromEscaped = (value: string) => JSON.parse(`"${value}"`) as string;
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
}) {
  const baseAnswer = '';
  const hasProductContext = input.toolResults.some((result) => {
    const payload = result.payload as Record<string, unknown> | undefined;
    return Array.isArray(payload?.productIds) && payload.productIds.length > 0;
  });
  const subject = hasProductContext
    ? fromEscaped('\\u0432\\u044b\\u0431\\u0440\\u0430\\u043d\\u043d\\u044b\\u0435 \\u043f\\u043e\\u0437\\u0438\\u0446\\u0438\\u0438')
    : fromEscaped('\\u0432\\u043e\\u043f\\u0440\\u043e\\u0441');
  const append = (suffix: string) => baseAnswer ? `${baseAnswer}\n\n${suffix}` : suffix;
  if (hasLeadContact(input.contact) && leadCaptureMissingName(input.toolResults)) {
    return append([
      fromEscaped('\\u0422\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d \\u043f\\u043e\\u043b\\u0443\\u0447\\u0438\\u043b.'),
      fromEscaped('\\u041d\\u0430\\u043f\\u0438\\u0448\\u0438\\u0442\\u0435, \\u043f\\u043e\\u0436\\u0430\\u043b\\u0443\\u0439\\u0441\\u0442\\u0430, \\u0438\\u043c\\u044f, \\u0438 \\u044f \\u043f\\u0435\\u0440\\u0435\\u0434\\u0430\\u043c'),
      subject,
      fromEscaped('\\u043d\\u0430 \\u043f\\u0440\\u043e\\u0432\\u0435\\u0440\\u043a\\u0443 \\u043f\\u0440\\u043e\\u0444\\u0438\\u043b\\u044c\\u043d\\u043e\\u043c\\u0443 \\u0441\\u043e\\u0442\\u0440\\u0443\\u0434\\u043d\\u0438\\u043a\\u0443.')
    ].join(' '));
  }
  return append([
    fromEscaped('\\u0427\\u0442\\u043e\\u0431\\u044b \\u043f\\u0440\\u043e\\u0432\\u0435\\u0440\\u0438\\u0442\\u044c \\u043d\\u0430\\u043b\\u0438\\u0447\\u0438\\u0435, \\u0434\\u043e\\u0441\\u0442\\u0430\\u0432\\u043a\\u0443, \\u0441\\u0440\\u043e\\u043a\\u0438 \\u0438\\u043b\\u0438 \\u0438\\u043d\\u0434\\u0438\\u0432\\u0438\\u0434\\u0443\\u0430\\u043b\\u044c\\u043d\\u044b\\u0435 \\u0443\\u0441\\u043b\\u043e\\u0432\\u0438\\u044f, \\u041e\\u0441\\u0442\\u0430\\u0432\\u044c\\u0442\\u0435 \\u0438\\u043c\\u044f \\u0438 \\u0442\\u0435\\u043b\\u0435\\u0444\\u043e\\u043d \\u0432 \\u0444\\u043e\\u0440\\u043c\\u0435.'),
    fromEscaped('\\u042f \\u043f\\u0435\\u0440\\u0435\\u0434\\u0430\\u043c'),
    subject,
    fromEscaped('\\u043d\\u0430 \\u0443\\u0442\\u043e\\u0447\\u043d\\u0435\\u043d\\u0438\\u0435.')
  ].join(' '));
}
