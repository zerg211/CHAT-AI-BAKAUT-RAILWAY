import type {
  CardManifest,
  FactClaimAudit,
  FactClaimPlanner,
  LeadStateMachine,
  PostAnswerVerification,
  PostAnswerVerificationIssue,
  ProductEvidenceRegistry
} from '../shared/types.js';
import { answerProductReferenceViolations } from './productEvidenceRegistry.js';
import { validateFactClaimAuditEvidence } from './evidence/claimEvidenceContract.js';

function normalized(value: unknown) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasContactAsk(answer: string) {
  return /(?:leave|send|write|provide|fill).{0,80}(?:phone|number|contact|name)|(?:callback|call\s+you)/iu.test(answer) ||
    /(?:\u043e\u0441\u0442\u0430\u0432|\u043d\u0430\u043f\u0438\u0448|\u0443\u043a\u0430\u0436|\u043f\u0440\u0438\u0448\u043b|\u0437\u0430\u043f\u043e\u043b\u043d).{0,100}(?:\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u043d\u043e\u043c\u0435\u0440|\u043a\u043e\u043d\u0442\u0430\u043a\u0442|\u0438\u043c\u044f)|(?:\u0438\u043c\u044f|\u0442\u0435\u043b\u0435\u0444\u043e\u043d|\u043d\u043e\u043c\u0435\u0440|\u043a\u043e\u043d\u0442\u0430\u043a\u0442).{0,80}(?:\u0444\u043e\u0440\u043c|\u0437\u0430\u044f\u0432\u043a)/iu.test(answer);
}

function stripContactAskSentences(answer: string) {
  const sentences = answer.split(/(?<=[.!?\n])\s+/u);
  const kept = sentences.filter((sentence) => !hasContactAsk(sentence));
  return (kept.length ? kept : sentences).join(' ').replace(/\s{2,}/gu, ' ').trim();
}

function hasVerificationWording(answer: string) {
  return /(?:verify|confirm|check|calculate|logistics|before\s+(?:ordering|checkout))/iu.test(answer) ||
    /(?:\u0441\u0432\u0435\u0440|\u0443\u0442\u043e\u0447\u043d|\u043f\u0440\u043e\u0432\u0435\u0440|\u043f\u043e\u0441\u0447\u0438\u0442|\u0441\u043e\u0433\u043b\u0430\u0441|\u043b\u043e\u0433\u0438\u0441\u0442|\u043f\u0435\u0440\u0435\u0434\s+\u043e\u0444\u043e\u0440\u043c\u043b)/iu.test(answer);
}

function hasFinalCommercialPromise(answer: string) {
  return /(?:in\s+stock|available\s+(?:now|today)|delivery\s+(?:is|costs|will)|discount\s+(?:is|will)|ships\s+today)/iu.test(answer) ||
    /(?:\u0442\u043e\u0447\u043d\u043e\s+)?(?:\u0435\u0441\u0442\u044c\s+\u0432\s+\u043d\u0430\u043b\u0438\u0447\u0438\u0438|\u043d\u0430\s+\u0441\u043a\u043b\u0430\u0434\u0435|\u043e\u0442\u0433\u0440\u0443\u0437\u0438\u043c\s+(?:\u0441\u0435\u0433\u043e\u0434\u043d\u044f|\u0437\u0430\u0432\u0442\u0440\u0430)|\u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430\s+(?:\u0441\u0442\u043e\u0438\u0442|\u0431\u0443\u0434\u0435\u0442|\u0431\u0435\u0441\u043f\u043b\u0430\u0442\u043d)|\u0441\u043a\u0438\u0434\u043a\u0430\s+(?:\u0431\u0443\u0434\u0435\u0442|\u0435\u0441\u0442\u044c|\u0441\u043e\u0441\u0442\u0430\u0432\u0438\u0442))/iu.test(answer);
}

function hasThirdPersonManagerRole(answer: string) {
  return /(?:\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440[\u0430-\u044f\u0451]*[^.!?\n]{0,120}(?:\u0441\u0432\u044f\u0436|\u043f\u0435\u0440\u0435\u0437\u0432\u043e\u043d|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434|\u043f\u0440\u043e\u0432\u0435\u0440|\u0443\u0442\u043e\u0447\u043d|\u043f\u043e\u0441\u0447\u0438\u0442|\u0441\u0432\u0435\u0440|\u043e\u0444\u043e\u0440\u043c)|(?:\u0441\u0432\u044f\u0436|\u043f\u0435\u0440\u0435\u0437\u0432\u043e\u043d|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434|\u043f\u0440\u043e\u0432\u0435\u0440|\u0443\u0442\u043e\u0447\u043d|\u043f\u043e\u0441\u0447\u0438\u0442|\u0441\u0432\u0435\u0440|\u043e\u0444\u043e\u0440\u043c)[^.!?\n]{0,120}\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440[\u0430-\u044f\u0451]*|\u0447\u0435\u0440\u0435\u0437\s+\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440[\u0430-\u044f\u0451]*|\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440[\u0430-\u044f\u0451]*\s*(?:\/|\u0438\u043b\u0438\s+|\u0438\s+)\s*\u043b\u043e\u0433\u0438\u0441\u0442)/iu.test(answer);
}

function isWhitespaceCharacter(character: string | undefined) {
  return character !== undefined && character.trim() === '';
}

function isSentencePunctuation(character: string | undefined) {
  return character === '.' || character === '!' || character === '?';
}

function isCommercialSentenceEnd(character: string | undefined) {
  return isSentencePunctuation(character) || character === '\n';
}

function matchTokenPhraseAt(value: string, lower: string, start: number, tokens: readonly string[]) {
  let position = start;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!lower.startsWith(token, position)) return null;
    position += token.length;
    if (index === tokens.length - 1) continue;
    if (!isWhitespaceCharacter(value[position])) return null;
    while (isWhitespaceCharacter(value[position])) position += 1;
  }
  return position;
}

function replaceTokenPhrases(
  value: string,
  phrases: ReadonlyArray<readonly string[]>,
  replacement: string,
  throughSentenceEnd = false
) {
  const lower = value.toLocaleLowerCase('ru');
  let result = '';
  let position = 0;
  while (position < value.length) {
    let matchEnd: number | null = null;
    for (const phrase of phrases) {
      matchEnd = matchTokenPhraseAt(value, lower, position, phrase);
      if (matchEnd !== null) break;
    }
    if (matchEnd === null) {
      result += value[position];
      position += 1;
      continue;
    }
    if (throughSentenceEnd) {
      while (matchEnd < value.length && !isCommercialSentenceEnd(value[matchEnd])) matchEnd += 1;
    }
    result += replacement;
    position = matchEnd;
  }
  return result;
}

function collapseRepeatedWhitespace(value: string) {
  let result = '';
  let position = 0;
  while (position < value.length) {
    if (!isWhitespaceCharacter(value[position])) {
      result += value[position];
      position += 1;
      continue;
    }
    const whitespaceStart = position;
    while (isWhitespaceCharacter(value[position])) position += 1;
    result += position - whitespaceStart >= 2 ? ' ' : value[whitespaceStart];
  }
  return result;
}

function softenCommercialPromises(answer: string) {
  let repaired = replaceTokenPhrases(answer, [
    ['\u0442\u043e\u0447\u043d\u043e', '\u0435\u0441\u0442\u044c', '\u0432', '\u043d\u0430\u043b\u0438\u0447\u0438\u0438'],
    ['\u0435\u0441\u0442\u044c', '\u0432', '\u043d\u0430\u043b\u0438\u0447\u0438\u0438']
  ], '\u0430\u043a\u0442\u0443\u0430\u043b\u044c\u043d\u043e\u0435 \u043d\u0430\u043b\u0438\u0447\u0438\u0435 \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c');
  repaired = replaceTokenPhrases(repaired, [['\u043d\u0430', '\u0441\u043a\u043b\u0430\u0434\u0435']], '\u0441\u043a\u043b\u0430\u0434 \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c');
  repaired = replaceTokenPhrases(repaired, [
    ['\u043e\u0442\u0433\u0440\u0443\u0437\u0438\u043c', '\u0441\u0435\u0433\u043e\u0434\u043d\u044f'],
    ['\u043e\u0442\u0433\u0440\u0443\u0437\u0438\u043c', '\u0437\u0430\u0432\u0442\u0440\u0430']
  ], '\u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e\u0441\u0442\u044c \u043e\u0442\u0433\u0440\u0443\u0437\u043a\u0438 \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c');
  repaired = replaceTokenPhrases(repaired, [
    ['\u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430', '\u0441\u0442\u043e\u0438\u0442'],
    ['\u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430', '\u0431\u0443\u0434\u0435\u0442'],
    ['\u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430', '\u0431\u0435\u0441\u043f\u043b\u0430\u0442\u043d']
  ], '\u0441\u0442\u043e\u0438\u043c\u043e\u0441\u0442\u044c \u0438 \u0443\u0441\u043b\u043e\u0432\u0438\u044f \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0438 \u043f\u043e\u0441\u0447\u0438\u0442\u0430\u044e \u0447\u0435\u0440\u0435\u0437 \u043b\u043e\u0433\u0438\u0441\u0442\u0438\u043a\u0443', true);
  repaired = replaceTokenPhrases(repaired, [
    ['\u0441\u043a\u0438\u0434\u043a\u0430', '\u0431\u0443\u0434\u0435\u0442'],
    ['\u0441\u043a\u0438\u0434\u043a\u0430', '\u0435\u0441\u0442\u044c'],
    ['\u0441\u043a\u0438\u0434\u043a\u0430', '\u0441\u043e\u0441\u0442\u0430\u0432\u0438\u0442']
  ], '\u043a\u043e\u043c\u043c\u0435\u0440\u0447\u0435\u0441\u043a\u0438\u0435 \u0443\u0441\u043b\u043e\u0432\u0438\u044f \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c', true);
  return collapseRepeatedWhitespace(repaired).trim();
}

function thirdPersonManagerReplacement(match: string) {
  const lower = match.toLocaleLowerCase('ru');
  if (/(?:\u0434\u043e\u0441\u0442\u0430\u0432|\u043b\u043e\u0433\u0438\u0441|\u0441\u0440\u043e\u043a|\u0430\u0434\u0440\u0435\u0441|\u043e\u0442\u043f\u0440\u0430\u0432)/iu.test(lower)) {
    return '\u0414\u043e\u0441\u0442\u0430\u0432\u043a\u0443 \u0438 \u0443\u0441\u043b\u043e\u0432\u0438\u044f \u043f\u043e\u0441\u0447\u0438\u0442\u0430\u044e \u043f\u043e \u0430\u0434\u0440\u0435\u0441\u0443 \u0447\u0435\u0440\u0435\u0437 \u043b\u043e\u0433\u0438\u0441\u0442\u0438\u043a\u0443.';
  }
  if (/(?:\u043d\u0430\u043b\u0438\u0447|\u0441\u043a\u043b\u0430\u0434|\u043e\u0442\u0433\u0440\u0443\u0437|\u043e\u0441\u0442\u0430\u0442)/iu.test(lower)) {
    return '\u0410\u043a\u0442\u0443\u0430\u043b\u044c\u043d\u044b\u0439 \u0441\u043a\u043b\u0430\u0434 \u0438 \u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e\u0441\u0442\u044c \u043e\u0442\u0433\u0440\u0443\u0437\u043a\u0438 \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c.';
  }
  if (/(?:\u0441\u043a\u0438\u0434|\u0446\u0435\u043d|\u0443\u0441\u043b\u043e\u0432|\u043a\u043e\u043c\u043c\u0435\u0440\u0447)/iu.test(lower)) {
    return '\u041a\u043e\u043c\u043c\u0435\u0440\u0447\u0435\u0441\u043a\u0438\u0435 \u0443\u0441\u043b\u043e\u0432\u0438\u044f \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c.';
  }
  return '\u0414\u0435\u0442\u0430\u043b\u0438 \u0441\u0432\u0435\u0440\u044e \u043f\u0435\u0440\u0435\u0434 \u043e\u0444\u043e\u0440\u043c\u043b\u0435\u043d\u0438\u0435\u043c.';
}

const managerActionStems = [
  '\u0441\u0432\u044f\u0436',
  '\u043f\u0435\u0440\u0435\u0437\u0432\u043e\u043d',
  '\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0434',
  '\u043f\u0440\u043e\u0432\u0435\u0440',
  '\u0443\u0442\u043e\u0447\u043d',
  '\u043f\u043e\u0441\u0447\u0438\u0442',
  '\u0441\u0432\u0435\u0440',
  '\u043e\u0444\u043e\u0440\u043c'
];

function occurrenceIndexes(text: string, token: string, maxStart = Number.POSITIVE_INFINITY) {
  const indexes: number[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const index = text.indexOf(token, searchFrom);
    if (index < 0 || index > maxStart) break;
    indexes.push(index);
    searchFrom = index + 1;
  }
  return indexes;
}

function isRussianLetter(character: string | undefined) {
  if (!character) return false;
  const lower = character.toLocaleLowerCase('ru');
  return (lower >= '\u0430' && lower <= '\u044f') || lower === '\u0451';
}

function managerWordEnd(text: string, start: number) {
  let end = start + '\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440'.length;
  while (isRussianLetter(text[end])) end += 1;
  return end;
}

function sentenceHasManagerActionPair(lower: string) {
  const managerIndexes = occurrenceIndexes(lower, '\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440', 180);
  for (const managerIndex of managerIndexes) {
    const managerEnd = managerWordEnd(lower, managerIndex);
    if (managerActionStems.some((action) => {
      const actionIndex = lower.indexOf(action, managerEnd);
      return actionIndex >= managerEnd && actionIndex - managerEnd <= 120;
    })) return true;
  }

  for (const action of managerActionStems) {
    for (const actionIndex of occurrenceIndexes(lower, action, 180)) {
      const managerIndex = lower.indexOf('\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440', actionIndex + action.length);
      if (managerIndex >= 0 && managerIndex - actionIndex - action.length <= 120) return true;
    }
  }
  return false;
}

function sentenceHasThroughManager(lower: string) {
  for (const throughIndex of occurrenceIndexes(lower, '\u0447\u0435\u0440\u0435\u0437', 180)) {
    let position = throughIndex + '\u0447\u0435\u0440\u0435\u0437'.length;
    if (!isWhitespaceCharacter(lower[position])) continue;
    while (isWhitespaceCharacter(lower[position])) position += 1;
    if (lower.startsWith('\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440', position)) return true;
  }
  return false;
}

function sentenceHasManagerLogistics(lower: string) {
  for (const managerIndex of occurrenceIndexes(lower, '\u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440', 180)) {
    let position = managerWordEnd(lower, managerIndex);
    while (isWhitespaceCharacter(lower[position])) position += 1;
    if (lower[position] === '/') {
      position += 1;
    } else if (lower.startsWith('\u0438\u043b\u0438', position) && isWhitespaceCharacter(lower[position + 3])) {
      position += 3;
      while (isWhitespaceCharacter(lower[position])) position += 1;
    } else if (lower[position] === '\u0438' && isWhitespaceCharacter(lower[position + 1])) {
      position += 1;
      while (isWhitespaceCharacter(lower[position])) position += 1;
    } else {
      continue;
    }
    while (isWhitespaceCharacter(lower[position])) position += 1;
    if (lower.startsWith('\u043b\u043e\u0433\u0438\u0441\u0442', position)) return true;
  }
  return false;
}

function sentenceNeedsManagerReplacement(sentenceBody: string) {
  const lower = sentenceBody.toLocaleLowerCase('ru');
  return sentenceHasManagerActionPair(lower) || sentenceHasThroughManager(lower) || sentenceHasManagerLogistics(lower);
}

function sentenceBounds(value: string, contentStart: number) {
  let bodyEnd = contentStart;
  while (bodyEnd < value.length && !isCommercialSentenceEnd(value[bodyEnd])) bodyEnd += 1;
  return {
    bodyEnd,
    segmentEnd: isSentencePunctuation(value[bodyEnd]) ? bodyEnd + 1 : bodyEnd
  };
}

function managerSentenceCandidates(value: string) {
  const candidates = [{ replacementStart: 0, contentStart: 0 }];
  for (let position = 0; position < value.length; position += 1) {
    if (!isSentencePunctuation(value[position]) || !isWhitespaceCharacter(value[position + 1])) continue;
    let contentStart = position + 1;
    while (isWhitespaceCharacter(value[contentStart])) contentStart += 1;
    candidates.push({ replacementStart: position + 1, contentStart });
  }
  return candidates;
}

function replaceThirdPersonManagerSentences(value: string) {
  let result = '';
  let copiedThrough = 0;
  for (const candidate of managerSentenceCandidates(value)) {
    if (candidate.replacementStart < copiedThrough) continue;
    const bounds = sentenceBounds(value, candidate.contentStart);
    const sentenceBody = value.slice(candidate.contentStart, bounds.bodyEnd);
    if (!sentenceNeedsManagerReplacement(sentenceBody)) continue;
    result += value.slice(copiedThrough, candidate.replacementStart);
    result += thirdPersonManagerReplacement(value.slice(candidate.replacementStart, bounds.segmentEnd));
    copiedThrough = bounds.segmentEnd;
  }
  return result + value.slice(copiedThrough);
}

function removeWhitespaceBeforePunctuation(value: string) {
  let result = '';
  let position = 0;
  while (position < value.length) {
    if (!isWhitespaceCharacter(value[position])) {
      result += value[position];
      position += 1;
      continue;
    }
    const whitespaceStart = position;
    while (isWhitespaceCharacter(value[position])) position += 1;
    const next = value[position];
    if (next === ',' || isSentencePunctuation(next)) continue;
    result += value.slice(whitespaceStart, position);
  }
  return result;
}

function softenThirdPersonManagerRole(answer: string) {
  const repaired = replaceThirdPersonManagerSentences(answer);
  return collapseRepeatedWhitespace(removeWhitespaceBeforePunctuation(repaired)).trim();
}

function answerMentionsName(answer: string, name: string) {
  const cleanAnswer = normalized(answer);
  const cleanName = normalized(name);
  if (!cleanName) return false;
  if (cleanAnswer.includes(cleanName)) return true;
  const distinctiveTokens = cleanName
    .split(/[^a-z0-9\u0430-\u044f\u0451]+/iu)
    .filter((token) => token.length >= 4);
  return distinctiveTokens.length >= 2 && distinctiveTokens.every((token) => cleanAnswer.includes(token));
}

function statusForIssues(issues: PostAnswerVerificationIssue[]): PostAnswerVerification['status'] {
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.length) return 'warn';
  return 'pass';
}

function factClaimAuditSeverity(warning: string): PostAnswerVerificationIssue['severity'] {
  if (
    warning === 'availability_claim_without_specialist_verification_wording' ||
    warning === 'delivery_claim_without_specialist_verification_wording' ||
    warning === 'terms_claim_without_specialist_verification_wording' ||
    warning === 'current_lineup_claim_without_web_policy'
  ) {
    return 'error';
  }
  return 'warning';
}

const deterministicRepairableIssueCodes = new Set([
  'lead_contact_ask_forbidden',
  'lead_contact_ask_after_created',
  'unverified_specialist_fact_promise',
  'third_person_manager_role_handoff',
  'fact_claim_audit:availability_claim_without_specialist_verification_wording',
  'fact_claim_audit:delivery_claim_without_specialist_verification_wording',
  'fact_claim_audit:terms_claim_without_specialist_verification_wording'
]);

export function classifyPostAnswerRecovery(verification: PostAnswerVerification) {
  const errorCodes = verification.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);
  const repairableIssues = errorCodes.filter((code) => deterministicRepairableIssueCodes.has(code));
  const unrecoverableIssues = errorCodes.filter((code) => !deterministicRepairableIssueCodes.has(code));
  return {
    repairableIssues,
    unrecoverableIssues,
    canAttemptDeterministicRepair: repairableIssues.length > 0,
    requiresRegenerationOrTooling: unrecoverableIssues.length > 0
  };
}

export function verifyPostAnswer(input: {
  answer: string;
  factClaimPlanner: FactClaimPlanner;
  leadStateMachine: LeadStateMachine;
  cardManifest: CardManifest;
  factClaimAudit?: FactClaimAudit;
  productEvidenceRegistry?: ProductEvidenceRegistry;
}): PostAnswerVerification {
  const issues: PostAnswerVerificationIssue[] = [];

  if (input.leadStateMachine.nextAction === 'do_not_ask_contact' && hasContactAsk(input.answer)) {
    issues.push({
      code: 'lead_contact_ask_forbidden',
      severity: 'error',
      message: 'Answer asks for contact while lead policy forbids contact collection.'
    });
  }
  if (input.leadStateMachine.leadCreated && hasContactAsk(input.answer)) {
    issues.push({
      code: 'lead_contact_ask_after_created',
      severity: 'error',
      message: 'Answer asks for contact even though the lead/contact was already captured.'
    });
  }

  if (
    input.factClaimPlanner.forbiddenClaims.includes('do_not_promise_live_stock_delivery_discount_or_exact_terms') &&
    hasFinalCommercialPromise(input.answer) &&
    !hasVerificationWording(input.answer)
  ) {
    issues.push({
      code: 'unverified_specialist_fact_promise',
      severity: 'error',
      message: 'Answer appears to promise stock, delivery, discount, or exact terms without verification wording.'
    });
  }
  if (hasThirdPersonManagerRole(input.answer)) {
    issues.push({
      code: 'third_person_manager_role_handoff',
      severity: 'error',
      message: 'Answer phrases the AI sales manager as a third-person manager instead of speaking in first person.'
    });
  }

  const violatingVisibleItems = input.cardManifest.items.filter((item) =>
    item.visible && item.constraintStatus === 'violates_hard_constraints'
  );
  for (const item of violatingVisibleItems) {
    if (answerMentionsName(input.answer, item.name)) {
      issues.push({
        code: 'violating_card_named_as_recommendation',
        severity: 'error',
        message: `Answer names visible card ${item.productId} even though it violates hard constraints.`
      });
    } else {
      issues.push({
        code: 'visible_card_constraint_violation_present',
        severity: 'warning',
        message: `Visible card ${item.productId} violates hard constraints.`
      });
    }
  }

  for (const warning of input.factClaimPlanner.warnings) {
    issues.push({
      code: warning,
      severity: warning.startsWith('visible_card_constraint_violation:') ? 'error' : 'warning',
      message: `Fact claim planner warning: ${warning}`
    });
  }
  for (const warning of input.factClaimAudit?.warnings ?? []) {
    issues.push({
      code: `fact_claim_audit:${warning}`,
      severity: factClaimAuditSeverity(warning),
      message: `Fact claim audit warning: ${warning}`
    });
  }
  if (input.factClaimAudit) {
    const evidenceValidation = validateFactClaimAuditEvidence(input.factClaimAudit);
    for (const violation of evidenceValidation.violations) {
      issues.push({
        code: `claim_evidence_contract:${violation.reason}`,
        severity: 'error',
        message: `Claim evidence contract violation: ${violation.reason}. ${violation.repairAction}`
      });
    }
  }
  for (const productId of input.productEvidenceRegistry ? answerProductReferenceViolations({
    answer: input.answer,
    registry: input.productEvidenceRegistry
  }) : []) {
    issues.push({
      code: 'disallowed_product_named_in_answer',
      severity: 'error',
      message: `Answer names product ${productId} even though product evidence registry does not allow it in answer text.`
    });
  }

  if (input.productEvidenceRegistry) {
    const registryById = new Map(input.productEvidenceRegistry.items.map((item) => [item.productId, item]));
    const manifestVisibleIds = new Set([
      ...input.cardManifest.visibleProductIds,
      ...input.cardManifest.items.filter((item) => item.visible).map((item) => item.productId)
    ]);
    for (const productId of Array.from(manifestVisibleIds)) {
      const registryItem = registryById.get(productId);
      if (registryItem && registryItem.allowedAsVisibleCard === false) {
        issues.push({
          code: 'final_payload_disallowed_visible_card',
          severity: 'error',
          message: `Final payload exposes card ${productId} even though product evidence registry forbids it as a visible card.`
        });
      }
      if (input.productEvidenceRegistry.rejectedProductIds.includes(productId)) {
        issues.push({
          code: 'final_payload_rejected_visible_card',
          severity: 'error',
          message: `Final payload exposes rejected product ${productId} as a visible card.`
        });
      }
    }
  }

  return {
    version: 1,
    status: statusForIssues(issues),
    issues,
    checkedPolicies: [
      'lead_contact_policy',
      'specialist_fact_policy',
      'ai_manager_voice_policy',
      'visible_card_constraint_policy',
      'fact_claim_planner_warnings',
      'fact_claim_audit_warnings',
      'claim_evidence_contract',
      'product_evidence_registry',
      'final_payload_atomic_validation'
    ]
  };
}

export function repairAnswerForPostAnswerVerification(input: {
  answer: string;
  verification: PostAnswerVerification;
}) {
  const recovery = classifyPostAnswerRecovery(input.verification);
  if (!recovery.canAttemptDeterministicRepair) return input.answer.trim();

  let repaired = input.answer.trim();
  const issueCodes = new Set(input.verification.issues.map((issue) => issue.code));

  if (issueCodes.has('lead_contact_ask_forbidden') || issueCodes.has('lead_contact_ask_after_created')) {
    repaired = stripContactAskSentences(repaired);
  }
  if (issueCodes.has('unverified_specialist_fact_promise')) {
    repaired = softenCommercialPromises(repaired);
  }
  if (issueCodes.has('third_person_manager_role_handoff')) {
    repaired = softenThirdPersonManagerRole(repaired);
  }
  if (
    issueCodes.has('fact_claim_audit:availability_claim_without_specialist_verification_wording') ||
    issueCodes.has('fact_claim_audit:delivery_claim_without_specialist_verification_wording') ||
    issueCodes.has('fact_claim_audit:terms_claim_without_specialist_verification_wording')
  ) {
    repaired = softenCommercialPromises(repaired);
  }

  return repaired || input.answer.trim();
}
