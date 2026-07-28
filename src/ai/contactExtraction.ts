export type ExtractedContact = {
  name?: string;
  phone?: string;
  email?: string;
};

function isWhitespace(char: string) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v' || char === '\u00a0';
}

function normalizeWhitespace(text: string) {
  let normalized = '';
  let previousWasSpace = false;
  for (const char of text) {
    if (isWhitespace(char)) {
      if (!previousWasSpace) normalized += ' ';
      previousWasSpace = true;
      continue;
    }
    normalized += char;
    previousWasSpace = false;
  }
  return normalized.trim();
}

function isAsciiLetter(char: string) {
  const code = char.toLowerCase().charCodeAt(0);
  return code >= 97 && code <= 122;
}

function isAsciiDigit(char: string) {
  return char >= '0' && char <= '9';
}

function isCyrillicLetter(char: string) {
  const lower = char.toLocaleLowerCase('ru-RU');
  return lower === 'ё' || (lower >= 'а' && lower <= 'я');
}

function isNameLetter(char: string) {
  return isAsciiLetter(char) || isCyrillicLetter(char);
}

function isNameBody(char: string) {
  return isNameLetter(char) || char === '-';
}

function isEmailLocalChar(char: string) {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === '.' || char === '_' || char === '%' || char === '+' || char === '-';
}

function isEmailDomainChar(char: string) {
  return isAsciiLetter(char) || isAsciiDigit(char) || char === '.' || char === '-';
}

function hasEmailTopLevelDomain(domain: string) {
  const dotIndex = domain.lastIndexOf('.');
  if (dotIndex < 1 || dotIndex >= domain.length - 2) return false;
  for (const char of domain.slice(dotIndex + 1)) {
    if (!isAsciiLetter(char)) return false;
  }
  return true;
}

function extractEmail(normalized: string) {
  for (let at = 0; at < normalized.length; at += 1) {
    if (normalized[at] !== '@') continue;

    let start = at - 1;
    while (start >= 0 && isEmailLocalChar(normalized[start])) start -= 1;
    start += 1;

    let end = at + 1;
    while (end < normalized.length && isEmailDomainChar(normalized[end])) end += 1;
    while (end > at + 1 && !isAsciiLetter(normalized[end - 1]) && !isAsciiDigit(normalized[end - 1])) end -= 1;

    const local = normalized.slice(start, at);
    const domain = normalized.slice(at + 1, end);
    if (local && hasEmailTopLevelDomain(domain)) {
      return normalized.slice(start, end);
    }
  }
  return undefined;
}

function isPhoneBodyChar(char: string) {
  return isAsciiDigit(char) || isWhitespace(char) || char === '(' || char === ')' || char === '.' || char === '-';
}

function compactPhone(candidate: string) {
  let compacted = '';
  let previousWasSpace = false;
  for (const char of candidate.trim()) {
    if (isWhitespace(char)) {
      if (!previousWasSpace) compacted += ' ';
      previousWasSpace = true;
      continue;
    }
    compacted += char;
    previousWasSpace = false;
  }
  return compacted.trim();
}

function phoneDigitCount(candidate: string) {
  let count = 0;
  for (const char of candidate) if (isAsciiDigit(char)) count += 1;
  return count;
}

function phoneDigits(candidate: string) {
  let output = '';
  for (const char of candidate) if (isAsciiDigit(char)) output += char;
  return output;
}

const phoneContextMarkers = ['телефон', 'тел.', 'номер телефона', 'phone', 'mobile'];
const technicalNumberMarkers = ['артикул', 'код', 'sku', 'модель', 'серийный', 'ean', 'штрихкод'];

function plausiblePhoneCandidate(normalized: string, start: number, candidate: string, startsWithPlus: boolean) {
  const lowerPrefix = normalized.slice(Math.max(0, start - 48), start).toLocaleLowerCase('ru-RU');
  const latestPhoneMarker = Math.max(...phoneContextMarkers.map((marker) => lowerPrefix.lastIndexOf(marker)));
  const latestTechnicalMarker = Math.max(...technicalNumberMarkers.map((marker) => lowerPrefix.lastIndexOf(marker)));
  if (latestTechnicalMarker > latestPhoneMarker) return false;
  if (startsWithPlus || latestPhoneMarker >= 0) return true;
  if ([...candidate].some((char) => char === '(' || char === ')' || char === '-' || char === '.')) return true;
  const digits = phoneDigits(candidate);
  return (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) ||
    (digits.length === 10 && digits.startsWith('9'));
}

function extractPhone(normalized: string) {
  for (let index = 0; index < normalized.length; index += 1) {
    if (index > 0 && isAsciiDigit(normalized[index - 1])) continue;
    const startsWithPlus = normalized[index] === '+' && isAsciiDigit(normalized[index + 1] ?? '');
    const startsWithDigit = isAsciiDigit(normalized[index]);
    if (!startsWithPlus && !startsWithDigit) continue;

    const start = index;
    let cursor = startsWithPlus ? index + 2 : index + 1;
    while (cursor < normalized.length && isPhoneBodyChar(normalized[cursor])) cursor += 1;

    let end = cursor;
    while (end > start && !isAsciiDigit(normalized[end - 1])) end -= 1;

    const candidate = normalized.slice(start, end);
    const digitCount = phoneDigitCount(candidate);
    if (
      digitCount >= 10 &&
      digitCount <= 15 &&
      plausiblePhoneCandidate(normalized, start, candidate, startsWithPlus)
    ) return compactPhone(candidate);
  }
  return undefined;
}

function isWordBoundary(text: string, index: number) {
  if (index < 0 || index >= text.length) return true;
  const char = text[index];
  return !isNameBody(char) && !isAsciiDigit(char);
}

function phraseAt(lowerText: string, phrase: string, index: number) {
  if (!lowerText.startsWith(phrase, index)) return false;
  return isWordBoundary(lowerText, index - 1) && isWordBoundary(lowerText, index + phrase.length);
}

function skipSpaces(text: string, index: number) {
  let cursor = index;
  while (cursor < text.length && text[cursor] === ' ') cursor += 1;
  return cursor;
}

function readNameToken(text: string, index: number) {
  if (!isNameLetter(text[index] ?? '')) return null;
  let cursor = index + 1;
  while (cursor < text.length && isNameBody(text[cursor])) cursor += 1;
  const value = text.slice(index, cursor);
  if (value.length < 2 || value.length > 31) return null;
  return { value, end: cursor };
}

function readName(text: string, index: number) {
  const first = readNameToken(text, skipSpaces(text, index));
  if (!first) return undefined;

  const secondStart = skipSpaces(text, first.end);
  const second = secondStart > first.end ? readNameToken(text, secondStart) : null;
  return second ? `${first.value} ${second.value}` : first.value;
}

function extractExplicitName(normalized: string) {
  const lower = normalized.toLocaleLowerCase('ru-RU');
  const phrases = ['меня зовут', 'мое имя', 'моё имя', 'имя:', 'my name is', 'name:'];
  for (const phrase of phrases) {
    for (let index = 0; index < lower.length; index += 1) {
      if (!phraseAt(lower, phrase, index)) continue;
      const name = readName(normalized, index + phrase.length);
      if (name) return name;
    }
  }
  return undefined;
}

function isUppercaseNameToken(value: string) {
  const parsed = readNameToken(value, 0);
  if (!parsed || parsed.end !== value.length) return false;
  const first = value[0] ?? '';
  return first.toLocaleUpperCase('ru-RU') === first &&
    first.toLocaleLowerCase('ru-RU') !== first;
}

const nonNamePrefixTokens = new Set([
  'хочу',
  'ищу',
  'могу',
  'нужен',
  'нужна',
  'нужно',
  'позвоните',
  'напишите',
  'телефон',
  'номер',
  'почта',
  'email',
  'артикул',
  'код',
  'sku',
  'модель',
  'серийный',
  'ean',
  'товар'
]);

function extractPronounName(normalized: string) {
  const lower = normalized.toLocaleLowerCase('ru-RU');
  for (let index = 0; index < lower.length; index += 1) {
    if (!phraseAt(lower, 'я', index)) continue;
    const first = readNameToken(normalized, skipSpaces(normalized, index + 1));
    if (!first || !isUppercaseNameToken(first.value)) continue;
    const firstLower = first.value.toLocaleLowerCase('ru-RU');
    if (nonNamePrefixTokens.has(firstLower)) continue;
    const secondStart = skipSpaces(normalized, first.end);
    const second = secondStart > first.end ? readNameToken(normalized, secondStart) : null;
    const hasSecondName = Boolean(
      second &&
      isUppercaseNameToken(second.value) &&
      !nonNamePrefixTokens.has(second.value.toLocaleLowerCase('ru-RU'))
    );
    const end = hasSecondName ? second!.end : first.end;
    const next = normalized[end] ?? '';
    if (next && next !== ',' && next !== ';' && next !== ':' && next !== '-' && next !== '.' && next !== '!' && next !== '?') {
      continue;
    }
    return hasSecondName ? `${first.value} ${second!.value}` : first.value;
  }
  return undefined;
}

export function containsExplicitContactName(text: string) {
  const normalized = normalizeWhitespace(text);
  return Boolean(extractExplicitName(normalized) || extractPronounName(normalized));
}

function trimTrailingNameSeparators(text: string) {
  let end = text.length;
  while (end > 0) {
    const char = text[end - 1];
    if (!isWhitespace(char) && char !== ',' && char !== ';' && char !== ':' && char !== '-') break;
    end -= 1;
  }
  return text.slice(0, end);
}

function extractPrefixName(normalized: string, contactIndex: number | undefined) {
  if (contactIndex === undefined) return undefined;
  const prefix = trimTrailingNameSeparators(normalized.slice(0, contactIndex));
  if (!prefix) return undefined;
  const parts = prefix.split(' ').filter(Boolean);
  if (parts.length === 2 && parts[0]?.toLocaleLowerCase('ru-RU') === 'я') {
    return isUppercaseNameToken(parts[1] ?? '') ? parts[1] : undefined;
  }
  if (parts.length < 1 || parts.length > 2) return undefined;
  if (parts.some((part) =>
    nonNamePrefixTokens.has(part.toLocaleLowerCase('ru-RU')) || !isUppercaseNameToken(part)
  )) return undefined;
  return parts.join(' ');
}

export function extractContact(text: string): ExtractedContact {
  const normalized = normalizeWhitespace(text);
  const email = extractEmail(normalized);
  const phone = extractPhone(normalized);
  const contactIndexes = [phone ? normalized.indexOf(phone) : -1, email ? normalized.indexOf(email) : -1]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  const contactIndex = contactIndexes[0];
  const name = (
    extractExplicitName(normalized) ??
    extractPronounName(normalized) ??
    extractPrefixName(normalized, contactIndex)
  )?.trim();
  return {
    name: name && name.length >= 2 ? name : undefined,
    phone,
    email
  };
}

export function hasLeadContact(contact: ExtractedContact) {
  return Boolean(contact.phone || contact.email);
}
