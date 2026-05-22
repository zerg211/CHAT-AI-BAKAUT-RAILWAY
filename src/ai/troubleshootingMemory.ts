import type { TroubleshootingCase, TroubleshootingCaseInput } from '../shared/types.js';
import { compactModelText, expandModelTokenAliases, extractModelTokens } from './productClassifier.js';

const problemTerms = [
  'ошибка', 'авария', 'код', 'табло', 'дисплей', 'не запускается', 'не заводится',
  'не глушится', 'не останавливается', 'не выключается', 'глохнет', 'дымит',
  'троит', 'стучит', 'перегрев', 'давление', 'масло', 'не работает', 'сбой',
  'alarm', 'error', 'fault', 'stop', 'shutdown', 'failure'
];

const stopWords = new Set([
  'вот', 'чем', 'вопрос', 'меня', 'после', 'этого', 'может', 'быть', 'почему',
  'какая', 'какой', 'какие', 'если', 'такой', 'такое', 'такая', 'уже', 'как',
  'что', 'для', 'или', 'при', 'там', 'тут', 'оно', 'она', 'они', 'его', 'ее',
  'this', 'that', 'with', 'from', 'what', 'why', 'how'
]);

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function isWhitespace(char: string) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

function compactWhitespace(value: string) {
  let result = '';
  let pendingSpace = false;
  for (const char of value.trim()) {
    if (isWhitespace(char)) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) {
      result += ' ';
      pendingSpace = false;
    }
    result += char;
  }
  return result;
}

function isAsciiDigit(char: string) {
  return char >= '0' && char <= '9';
}

function isLetter(char: string) {
  return char.toLocaleLowerCase('ru-RU') !== char.toLocaleUpperCase('ru-RU');
}

function isAlphaNumeric(char: string | undefined) {
  return Boolean(char && (isAsciiDigit(char) || isLetter(char)));
}

function isFaultCodeLetter(char: string | undefined) {
  if (!char) return false;
  const upper = char.toLocaleUpperCase('ru-RU');
  return (upper >= 'A' && upper <= 'Z') || (upper >= 'А' && upper <= 'Я');
}

function textTokens(value: string) {
  const tokens: string[] = [];
  let current = '';
  for (const char of value.toLocaleLowerCase('ru-RU')) {
    if (isAlphaNumeric(char)) {
      current += char;
      continue;
    }
    if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

const diagnosticCodeTerms = [
  'ошибк',
  'код',
  'табло',
  'диспле',
  'авари',
  'alarm',
  'error',
  'fault',
  'code'
];

function containsDiagnosticCodeTerm(value: string) {
  const normalized = value.toLocaleLowerCase('ru-RU');
  return diagnosticCodeTerms.some((term) => normalized.includes(term));
}

function trimToCurrentSentenceBefore(value: string) {
  let start = 0;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index];
    if (char === '.' || char === '?' || char === '!' || char === '\n') {
      start = index + 1;
      break;
    }
  }
  return value.slice(start);
}

function trimToCurrentSentenceAfter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '.' || char === '?' || char === '!' || char === '\n') {
      return value.slice(0, index);
    }
  }
  return value;
}

function readFaultCodeCandidate(text: string, start: number) {
  if (isAlphaNumeric(text[start - 1]) || !isFaultCodeLetter(text[start])) return null;

  let index = start;
  let letters = '';
  while (isFaultCodeLetter(text[index])) {
    letters += text[index];
    index += 1;
  }
  if (letters.length < 1 || letters.length > 2) return null;

  while (isWhitespace(text[index])) index += 1;
  if (text[index] === '-') {
    index += 1;
    while (isWhitespace(text[index])) index += 1;
  }

  let digits = '';
  while (isAsciiDigit(text[index])) {
    digits += text[index];
    index += 1;
  }
  if (digits.length < 1 || digits.length > 4 || isAlphaNumeric(text[index])) return null;

  return {
    code: `${letters}${digits}`.toLocaleUpperCase('ru-RU'),
    end: index
  };
}

export function normalizeTroubleshootingModelKey(value: string) {
  return compactModelText(value);
}

export function extractTroubleshootingModelTokens(text: string) {
  return unique(expandModelTokenAliases(extractModelTokens(text)))
    .map((token) => ({
      value: compactWhitespace(token),
      key: normalizeTroubleshootingModelKey(token)
    }))
    .filter((item) => item.key.length >= 4);
}

export function extractFaultCodes(text: string) {
  const codes: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const candidate = readFaultCodeCandidate(text, index);
    if (!candidate) continue;

    const beforeStart = Math.max(0, index - 50);
    const before = trimToCurrentSentenceBefore(text.slice(beforeStart, index));
    const after = trimToCurrentSentenceAfter(text.slice(candidate.end, candidate.end + 24));
    if (containsDiagnosticCodeTerm(before) || containsDiagnosticCodeTerm(after)) {
      codes.push(candidate.code);
    }
  }
  return unique(codes).slice(0, 8);
}

export function isTroubleshootingQuestion(text: string) {
  const normalized = text.toLowerCase();
  return extractTroubleshootingModelTokens(text).length > 0 &&
    (extractFaultCodes(text).length > 0 || problemTerms.some((term) => normalized.includes(term)));
}

function problemTokens(text: string, modelKeys: string[], faultCodes: string[]) {
  const compactModels = new Set(modelKeys);
  const compactFaults = new Set(faultCodes.map((code) => compactModelText(code)));
  return unique(
    textTokens(text)
      .filter((token) => token.length >= 3)
      .filter((token) => !stopWords.has(token))
      .filter((token) => !compactModels.has(compactModelText(token)))
      .filter((token) => !compactFaults.has(compactModelText(token)))
  ).slice(0, 12);
}

export function buildTroubleshootingProblemKey(input: {
  message: string;
  modelKey: string;
  faultCodes?: string[];
}) {
  const faultPart = (input.faultCodes ?? []).map((code) => compactModelText(code)).sort().join('_');
  const terms = problemTokens(input.message, [input.modelKey], input.faultCodes ?? []).slice(0, 8).join('_');
  return [faultPart || 'no_fault_code', terms || 'general_problem'].join('__').slice(0, 180);
}

export function buildTroubleshootingCaseDraft(input: {
  userMessage: string;
  answer: string;
  sourceUrls: string[];
  sourceTitles?: string[];
}): TroubleshootingCaseInput | null {
  if (!isTroubleshootingQuestion(input.userMessage)) return null;
  if (!input.answer.trim() || !input.sourceUrls.length) return null;
  const model = extractTroubleshootingModelTokens(input.userMessage)[0];
  if (!model) return null;
  const faultCodes = extractFaultCodes(input.userMessage);
  const problemSummary = compactWhitespace(input.userMessage).slice(0, 500);
  return {
    model: model.value,
    modelKey: model.key,
    faultCodes,
    problemSummary,
    problemKey: buildTroubleshootingProblemKey({
      message: input.userMessage,
      modelKey: model.key,
      faultCodes
    }),
    answer: input.answer.trim().slice(0, 3000),
    sourceUrls: unique(input.sourceUrls).slice(0, 12),
    sourceTitles: unique(input.sourceTitles ?? []).slice(0, 12),
    confidence: faultCodes.length ? 0.86 : 0.78,
    firstSeenMessage: problemSummary
  };
}

export function buildTroubleshootingSearchQuery(text: string) {
  const models = extractTroubleshootingModelTokens(text);
  const faultCodes = extractFaultCodes(text);
  return {
    query: text.trim(),
    modelKeys: models.map((model) => model.key),
    faultCodes
  };
}

export function troubleshootingCaseCoversQuery(item: TroubleshootingCase, queryText: string) {
  const query = buildTroubleshootingSearchQuery(queryText);
  if (!query.modelKeys.includes(item.modelKey)) return false;
  const queryFaultCodes = new Set(query.faultCodes);
  if (queryFaultCodes.size > 0) {
    return item.faultCodes.some((code) => queryFaultCodes.has(code));
  }
  const tokens = new Set(problemTokens(queryText, query.modelKeys, query.faultCodes));
  const caseTokens = new Set(problemTokens(item.problemSummary, [item.modelKey], item.faultCodes));
  let overlap = 0;
  for (const token of tokens) if (caseTokens.has(token)) overlap += 1;
  return overlap >= 2 || (item.semanticScore ?? 0) >= 0.82;
}
