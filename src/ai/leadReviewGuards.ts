import type { ToolResult } from './agentManagerContracts.js';
import { type ExtractedContact, hasLeadContact } from './contactExtraction.js';

const contactRequestStarts = [
  'оставьте', 'оставь', 'оставить',
  'напишите', 'напиши', 'написать',
  'укажите', 'укажи', 'указать',
  'отправьте', 'отправь', 'отправить',
  'сообщите', 'сообщи', 'сообщить',
  'пришлите', 'пришли', 'прислать',
  'продиктуйте', 'продиктуй',
  'provide', 'send', 'share', 'leave', 'write', 'enter', 'tell me'
];
const contactTargetRoots = ['телефон', 'контакт', 'почт'];
const ambiguousNumberTargets = new Set(['номер', 'number']);
const ambiguousNameTargets = new Set(['имя', 'name']);
const contactPossessiveRoots = ['ваш', 'вас', 'покупател', 'your', 'customer', 'buyer'];
const technicalIdentifierRoots = [
  'модел', 'серийн', 'артикул', 'товар', 'издел', 'заказ', 'двигател', 'рам',
  'детал', 'файл', 'каталог', 'продукт', 'производител', 'менеджер', 'договор',
  'счет', 'счёт', 'накладн', 'документ', 'model', 'serial', 'part', 'product',
  'item', 'order', 'engine', 'frame', 'file', 'manufacturer', 'manager', 'contract',
  'account', 'invoice', 'document', 'sku', 'ean', 'id'
];
const contactContextRoots = [
  'связ', 'позвон', 'звон', 'сообщен', 'напис', 'ответ',
  'call', 'message', 'reach', 'callback', 'contact', 'reply', 'text'
];

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
    const before = lowerText.slice(Math.max(0, index - 16), index).trimEnd();
    const negated = ['не', 'not', 'never', "don't", 'do not'].some((marker) =>
      before.endsWith(marker) &&
      (before.length === marker.length || before[before.length - marker.length - 1] === ' ')
    );
    if (negated) continue;
    if (!best || index < best.index || (index === best.index && phrase.length > best.phrase.length)) {
      best = { index, phrase };
    }
  }
  return best;
}

function targetWords(text: string) {
  const words: string[] = [];
  let current = '';
  for (const char of text) {
    const lower = char.toLocaleLowerCase('ru-RU');
    const upper = char.toLocaleUpperCase('ru-RU');
    const isDigit = char >= '0' && char <= '9';
    if (isDigit || lower !== upper) {
      current += lower;
      continue;
    }
    if (current) words.push(current);
    current = '';
  }
  if (current) words.push(current);
  return words;
}

function wordHasRoot(word: string | undefined, roots: string[]) {
  return Boolean(word && roots.some((root) => word.startsWith(root)));
}

function hasTechnicalIdentifierNear(words: string[], index: number) {
  const start = Math.max(0, index - 2);
  return words
    .slice(start, Math.min(words.length, index + 3))
    .some((word, nearbyIndex) =>
      start + nearbyIndex !== index && wordHasRoot(word, technicalIdentifierRoots)
    );
}

function containsContactRequestTarget(text: string) {
  const words = targetWords(text);
  if (words.some((word) => word === 'phone' || word === 'email' || wordHasRoot(word, contactTargetRoots))) {
    return true;
  }
  if (words.some((word, index) => word === 'e' && words[index + 1] === 'mail')) return true;
  const hasContactContext = words.some((word) => wordHasRoot(word, contactContextRoots));

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (!ambiguousNumberTargets.has(word) && !ambiguousNameTargets.has(word)) continue;
    if (hasTechnicalIdentifierNear(words, index)) continue;
    if (wordHasRoot(words[index - 1], contactPossessiveRoots) || hasContactContext) return true;
  }
  return false;
}

export function answerRequestsContactData(answerText: string) {
  const lower = lowerRu(answerText);
  let cursor = 0;
  while (cursor < lower.length) {
    const start = earliestContactRequestStart(lower, cursor);
    if (!start) return false;

    const segmentStart = start.index + start.phrase.length;
    const segmentEnd = Math.min(segmentStart + 100, nextLineBreak(lower, segmentStart));
    if (containsContactRequestTarget(lower.slice(segmentStart, segmentEnd))) return true;

    cursor = start.index + 1;
  }
  return false;
}

export function answerRequestsPhoneOrEmail(answerText: string) {
  const lower = lowerRu(answerText);
  let cursor = 0;
  while (cursor < lower.length) {
    const start = earliestContactRequestStart(lower, cursor);
    if (!start) return false;
    const segmentStart = start.index + start.phrase.length;
    const segmentEnd = Math.min(segmentStart + 100, nextLineBreak(lower, segmentStart));
    const words = targetWords(lower.slice(segmentStart, segmentEnd));
    if (words.some((word) =>
      word === 'phone' ||
      word === 'email' ||
      wordHasRoot(word, contactTargetRoots)
    )) return true;
    if (words.some((word, index) => word === 'e' && words[index + 1] === 'mail')) return true;
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
