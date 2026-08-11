const modelTextConfusables: Record<string, string> = {
  '\u0430': 'a',
  '\u0432': 'b',
  '\u0435': 'e',
  '\u043a': 'k',
  '\u043c': 'm',
  '\u043d': 'h',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0442': 't',
  '\u0443': 'y',
  '\u0445': 'x'
};

export function normalizeModelText(value: unknown) {
  const chars: string[] = [];
  for (const char of String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU')) {
    chars.push(modelTextConfusables[char] ?? char);
  }
  return chars.join('');
}

export function compactModelText(value: unknown) {
  return modelTextTokens(value).join('');
}

function charCode(char: string) {
  return char.codePointAt(0) ?? 0;
}

function isAsciiDigit(char: string) {
  const code = charCode(char);
  return code >= 48 && code <= 57;
}

function isAsciiLetter(char: string) {
  const code = charCode(char);
  return code >= 97 && code <= 122;
}

function isCyrillicLetter(char: string) {
  const code = charCode(char);
  return (code >= 0x0430 && code <= 0x044f) || code === 0x0451;
}

export function isModelTokenChar(char: string) {
  return isAsciiDigit(char) || isAsciiLetter(char) || isCyrillicLetter(char);
}

export function tokenHasLetter(token: string) {
  for (const char of token) {
    if (isAsciiLetter(char) || isCyrillicLetter(char)) return true;
  }
  return false;
}

export function tokenHasDigit(token: string) {
  for (const char of token) {
    if (isAsciiDigit(char)) return true;
  }
  return false;
}

export function modelTextTokens(value: unknown) {
  const tokens: string[] = [];
  let current = '';
  for (const char of normalizeModelText(value)) {
    if (isModelTokenChar(char)) {
      current += char;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function modelIdentifierTokens(value: unknown) {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of modelTextTokens(value).map(compactModelText)) {
    if (token.length < 4 || !tokenHasLetter(token) || !tokenHasDigit(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

export function modelIdentifierDisplayTokens(value: unknown) {
  const tokens: string[] = [];
  let current = '';
  for (const rawChar of String(value ?? '').normalize('NFKD')) {
    const normalizedChar = normalizeModelText(rawChar);
    if (normalizedChar.length === 1 && isModelTokenChar(normalizedChar)) {
      current += rawChar;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  const seen = new Set<string>();
  const displayTokens: string[] = [];
  for (const token of tokens) {
    const canonical = compactModelText(token);
    if (canonical.length < 4 || !tokenHasLetter(canonical) || !tokenHasDigit(canonical) || seen.has(canonical)) continue;
    seen.add(canonical);
    displayTokens.push(token);
  }
  return displayTokens;
}

function uniqueModelTokens(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function tokenStartsWithLetter(token: string) {
  const first = token[0] ?? '';
  return isAsciiLetter(first) || isCyrillicLetter(first);
}

function exactIdentityIdentifierTokens(value: unknown) {
  const mixedTokens = uniqueModelTokens(modelTextTokens(value).map(compactModelText)).filter((token) =>
    token.length >= 2 && tokenHasLetter(token) && tokenHasDigit(token)
  );
  const strongTokens = mixedTokens.filter((token) => token.length >= 4);
  if (!strongTokens.length) return [];
  return uniqueModelTokens([
    ...strongTokens,
    ...mixedTokens.filter((token) => tokenStartsWithLetter(token))
  ]);
}

function modelTextTokenLayout(value: unknown) {
  const tokens: string[] = [];
  const separators: string[] = [];
  let current = '';
  let pendingSeparator = '';
  for (const char of normalizeModelText(value)) {
    if (isModelTokenChar(char)) {
      if (!current && tokens.length > 0) {
        separators.push(pendingSeparator);
        pendingSeparator = '';
      }
      current += char;
    } else {
      if (current) {
        tokens.push(current);
        current = '';
      }
      pendingSeparator += char;
    }
  }
  if (current) tokens.push(current);
  return { tokens, separators };
}

function rawModelTextTokenLayout(value: unknown) {
  const tokens: string[] = [];
  const separators: string[] = [];
  let current = '';
  let pendingSeparator = '';
  for (const char of String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU')) {
    if (isModelTokenChar(char)) {
      if (!current && tokens.length > 0) {
        separators.push(pendingSeparator);
        pendingSeparator = '';
      }
      current += char;
    } else {
      if (current) {
        tokens.push(current);
        current = '';
      }
      pendingSeparator += char;
    }
  }
  if (current) tokens.push(current);
  return { tokens, separators };
}

function separatorHasWhitespace(value: string) {
  for (const char of value) {
    if (char.trim() === '') return true;
  }
  return false;
}

function tokenIsShortModelSuffix(token: string) {
  return token.length <= 3 && (tokenHasDigit(token) || tokenHasLetter(token));
}

function tokenOccurrenceIsExtended(layout: ReturnType<typeof modelTextTokenLayout>, index: number) {
  const nextToken = layout.tokens[index + 1];
  const nextSeparator = layout.separators[index];
  return Boolean(
    nextToken &&
    nextSeparator &&
    !separatorHasWhitespace(nextSeparator) &&
    tokenIsShortModelSuffix(nextToken)
  );
}

function targetPartCountForValueToken(
  valueToken: string,
  targetTokens: readonly string[],
  targetIndex: number
) {
  let joined = '';
  for (let index = targetIndex; index < targetTokens.length && index < targetIndex + 4; index += 1) {
    joined += targetTokens[index];
    if (joined === valueToken) return index - targetIndex + 1;
    if (!valueToken.startsWith(joined)) return 0;
  }
  return 0;
}

function layoutContainsIdentifier(layout: ReturnType<typeof modelTextTokenLayout>, identifier: string) {
  for (let start = 0; start < layout.tokens.length; start += 1) {
    let joined = '';
    for (let end = start; end < layout.tokens.length && end < start + 4; end += 1) {
      joined += layout.tokens[end];
      if (joined === identifier && !tokenOccurrenceIsExtended(layout, end)) return true;
      if (!identifier.startsWith(joined)) break;
    }
  }
  return false;
}

function includesExactTokenSequence(
  layout: ReturnType<typeof modelTextTokenLayout>,
  targetTokens: readonly string[]
) {
  if (!targetTokens.length) return false;
  for (let start = 0; start < layout.tokens.length; start += 1) {
    let valueIndex = start;
    let targetIndex = 0;
    while (targetIndex < targetTokens.length && valueIndex < layout.tokens.length) {
      const matchedParts = targetPartCountForValueToken(layout.tokens[valueIndex], targetTokens, targetIndex);
      if (!matchedParts) break;
      targetIndex += matchedParts;
      valueIndex += 1;
    }
    if (targetIndex === targetTokens.length && !tokenOccurrenceIsExtended(layout, valueIndex - 1)) return true;
  }
  return false;
}

function includesOrderedExactTokens(
  layout: ReturnType<typeof modelTextTokenLayout>,
  targetTokens: readonly string[]
) {
  if (!targetTokens.length) return false;
  let valueIndex = 0;
  let targetIndex = 0;
  while (targetIndex < targetTokens.length) {
    let matchedParts = 0;
    while (valueIndex < layout.tokens.length) {
      matchedParts = targetPartCountForValueToken(layout.tokens[valueIndex], targetTokens, targetIndex);
      if (matchedParts) break;
      valueIndex += 1;
    }
    if (valueIndex >= layout.tokens.length) return false;
    targetIndex += matchedParts;
    if (targetIndex === targetTokens.length && !tokenOccurrenceIsExtended(layout, valueIndex)) return true;
    valueIndex += 1;
  }
  return false;
}

const modelUnitTokens = new Set([
  'kw', 'квт', 'w', 'вт', 'kva', 'ква', 'v', 'в', 'kg', 'кг', 'hz', 'гц', 'rpm', 'об'
]);
const modelIdentityStopWords = new Set(['is', 'and', 'or', 'to', 'of', 'in', 'on', 'by', 'for', 'with', 'max', 'min', 'hp']);

function isDigitsOnlyToken(token: string) {
  return tokenHasDigit(token) && !tokenHasLetter(token);
}

function isLettersOnlyToken(token: string) {
  return tokenHasLetter(token) && !tokenHasDigit(token);
}

function isAsciiLettersOnlyToken(token: string) {
  return token.length > 0 && [...token].every(isAsciiLetter);
}

function splitModelIdentityTokens(value: unknown) {
  const layout = modelTextTokenLayout(value);
  const candidates: string[][] = [];
  for (let anchor = 0; anchor < layout.tokens.length; anchor += 1) {
    const anchorToken = layout.tokens[anchor];
    if (!isDigitsOnlyToken(anchorToken) || anchorToken.length < 3) continue;
    let start = anchor;
    while (start > 0) {
      const previous = layout.tokens[start - 1];
      const separator = layout.separators[start - 1] ?? '';
      const shortLetterPart = isLettersOnlyToken(previous) && previous.length <= 4 && !modelUnitTokens.has(previous);
      const joinedNumericPart = isDigitsOnlyToken(previous) && previous.length <= 4 && !separatorHasWhitespace(separator);
      if (!shortLetterPart && !joinedNumericPart) break;
      start -= 1;
    }
    let end = anchor;
    while (end + 1 < layout.tokens.length) {
      const next = layout.tokens[end + 1];
      const separator = layout.separators[end] ?? '';
      const shortLetterPart = isLettersOnlyToken(next) && next.length <= 4 && !modelUnitTokens.has(next);
      const mixedPart = tokenHasLetter(next) && tokenHasDigit(next) && next.length <= 8;
      const joinedNumericPart = isDigitsOnlyToken(next) && next.length <= 4 && !separatorHasWhitespace(separator);
      if (!shortLetterPart && !mixedPart && !joinedNumericPart) break;
      end += 1;
    }
    const candidate = layout.tokens.slice(start, end + 1);
    if (candidate.some(tokenHasLetter)) candidates.push(candidate);
  }
  return candidates.sort((left, right) => right.length - left.length)[0] ?? [];
}

/**
 * Finds all split model-code candidates in a buyer message. Unlike
 * modelIdentifierTokens(), this keeps multipart identities such as
 * "BPS 1550 Aw" and "GX160 QX2" intact even when the LLM has not yet
 * returned a productMention for them.
 */
export function modelIdentityCandidates(value: unknown) {
  const layout = rawModelTextTokenLayout(value);
  const candidates: string[][] = [];
  for (let anchor = 0; anchor < layout.tokens.length; anchor += 1) {
    const anchorToken = layout.tokens[anchor];
    const isMixedModelAnchor = tokenHasLetter(anchorToken) && tokenHasDigit(anchorToken) && anchorToken.length >= 4;
    if ((!isDigitsOnlyToken(anchorToken) && !isMixedModelAnchor) || anchorToken.length < 3) continue;
    let start = anchor;
    let precedingLetterParts = 0;
    while (start > 0) {
      const previous = layout.tokens[start - 1];
      const separator = layout.separators[start - 1] ?? '';
      const shortLetterPart = isAsciiLettersOnlyToken(previous) && previous.length <= 4 && !modelUnitTokens.has(previous);
      const joinedNumericPart = isDigitsOnlyToken(previous) && previous.length <= 4 && !separatorHasWhitespace(separator);
      if (shortLetterPart && precedingLetterParts >= 2) break;
      if (!shortLetterPart && !joinedNumericPart) break;
      if (shortLetterPart) precedingLetterParts += 1;
      start -= 1;
    }
    let end = anchor;
    while (end + 1 < layout.tokens.length) {
      const next = layout.tokens[end + 1];
      const separator = layout.separators[end] ?? '';
      const shortLetterPart = isAsciiLettersOnlyToken(next) && next.length <= 4 && !modelUnitTokens.has(next);
      const mixedPart = tokenHasLetter(next) && tokenHasDigit(next) && next.length <= 8;
      const joinedNumericPart = isDigitsOnlyToken(next) && next.length <= 4 && !separatorHasWhitespace(separator);
      if (!shortLetterPart && !mixedPart && !joinedNumericPart) break;
      end += 1;
    }
    const candidate = layout.tokens.slice(start, end + 1);
    if (candidate.some(tokenHasLetter) && !modelIdentityStopWords.has(candidate[0] ?? '')) candidates.push(candidate);
  }
  const seen = new Set<string>();
  return candidates
    .sort((left, right) => right.length - left.length)
    .map((candidate) => candidate.join(' '))
    .filter((candidate) => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    });
}

export interface ExactProductIdentity {
  targetName: string;
  decisiveParts: readonly string[];
  identifierParts: readonly string[];
  searchAliases: readonly string[];
  matches(value: unknown): boolean;
  hasExactMention(value: unknown): boolean;
}

export function exactProductIdentity(targetName: string): ExactProductIdentity {
  const targetTokens = modelTextTokens(targetName).map(compactModelText).filter(Boolean);
  const identifierParts = exactIdentityIdentifierTokens(targetName);
  const splitIdentifierParts = identifierParts.length ? [] : splitModelIdentityTokens(targetName);
  const decisiveParts = identifierParts.length
    ? identifierParts
    : splitIdentifierParts.length
      ? splitIdentifierParts
      : targetTokens;
  const searchAliases = uniqueModelTokens([
    `"${targetName}"`,
    targetName,
    ...identifierParts,
    ...identifierParts.map((token) => `"${token}"`)
  ]);
  return {
    targetName,
    decisiveParts,
    identifierParts,
    searchAliases,
    matches(value: unknown) {
      if (!decisiveParts.length) return false;
      const layout = modelTextTokenLayout(value);
      if (!identifierParts.length) return includesOrderedExactTokens(layout, decisiveParts);
      return identifierParts.every((identifier) => layoutContainsIdentifier(layout, identifier));
    },
    hasExactMention(value: unknown) {
      if (!decisiveParts.length) return false;
      const layout = modelTextTokenLayout(value);
      if (!identifierParts.length) return includesExactTokenSequence(layout, decisiveParts);
      return identifierParts.every((identifier) => layoutContainsIdentifier(layout, identifier));
    }
  };
}

function sameModelTokenShape(left: string, right: string) {
  return tokenHasLetter(left) === tokenHasLetter(right) &&
    tokenHasDigit(left) === tokenHasDigit(right) &&
    Math.abs(left.length - right.length) <= 2;
}

function hasUnexpectedMultipartVariant(value: unknown, identities: ExactProductIdentity[]) {
  const groups = new Map<string, { prefix: string[]; allowedSuffixes: Set<string> }>();
  for (const identity of identities) {
    if (identity.identifierParts.length || identity.decisiveParts.length < 2) continue;
    const prefix = [...identity.decisiveParts.slice(0, -1)];
    const suffix = identity.decisiveParts.at(-1);
    if (!suffix) continue;
    const key = prefix.join('\u0000');
    const group = groups.get(key) ?? { prefix, allowedSuffixes: new Set<string>() };
    group.allowedSuffixes.add(suffix);
    groups.set(key, group);
  }
  if (!groups.size) return false;

  const layout = modelTextTokenLayout(value);
  for (const { prefix, allowedSuffixes } of groups.values()) {
    for (let start = 0; start <= layout.tokens.length - prefix.length - 1; start += 1) {
      if (!prefix.every((token, offset) => layout.tokens[start + offset] === token)) continue;
      const candidateSuffix = layout.tokens[start + prefix.length];
      if (allowedSuffixes.has(candidateSuffix)) continue;
      if ([...allowedSuffixes].some((allowedSuffix) => sameModelTokenShape(candidateSuffix, allowedSuffix))) {
        return true;
      }
    }
  }
  return false;
}

export function textMatchesOnlyTargetNames(value: unknown, targetNames: string[]) {
  const identities = targetNames.map(exactProductIdentity).filter((identity) => identity.decisiveParts.length > 0);
  if (!identities.some((identity) => identity.hasExactMention(value))) return false;
  if (hasUnexpectedMultipartVariant(value, identities)) return false;
  const allowedIdentifiers = new Set(identities.flatMap((identity) => [...identity.identifierParts]));
  if (!allowedIdentifiers.size) return true;
  return exactIdentityIdentifierTokens(value).every((identifier) => allowedIdentifiers.has(identifier));
}

export function textMatchesTargetName(value: unknown, targetName: string) {
  return exactProductIdentity(targetName).matches(value);
}
