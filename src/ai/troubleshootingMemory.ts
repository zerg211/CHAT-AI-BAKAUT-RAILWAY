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

export function normalizeTroubleshootingModelKey(value: string) {
  return compactModelText(value);
}

export function extractTroubleshootingModelTokens(text: string) {
  return unique(expandModelTokenAliases(extractModelTokens(text)))
    .map((token) => ({
      value: token.trim().replace(/\s+/g, ' '),
      key: normalizeTroubleshootingModelKey(token)
    }))
    .filter((item) => item.key.length >= 4);
}

export function extractFaultCodes(text: string) {
  const codes: string[] = [];
  const patterns = [
    /(?:ошибк[аиу]?|код|табло|диспле[йя]|авари[яи]|alarm|error|fault|code)[^.?!\n]{0,50}\b([A-ZА-Я]{1,2}\s*-?\s*\d{1,4})\b/giu,
    /\b([A-ZА-Я]{1,2}\s*-?\s*\d{1,4})\b[^.?!\n]{0,24}(?:ошибк[аиу]?|код|табло|диспле[йя]|авари[яи]|alarm|error|fault|code)/giu
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const code = match[1]?.replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
      if (code && /^[A-ZА-Я]{1,2}\d{1,4}$/u.test(code)) codes.push(code);
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
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
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
  const problemSummary = input.userMessage.trim().replace(/\s+/g, ' ').slice(0, 500);
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
