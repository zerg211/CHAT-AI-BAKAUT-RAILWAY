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

function extractPhone(normalized: string) {
  for (let index = 0; index < normalized.length; index += 1) {
    const startsWithPlus = normalized[index] === '+' && isAsciiDigit(normalized[index + 1] ?? '');
    const startsWithDigit = isAsciiDigit(normalized[index]);
    if (!startsWithPlus && !startsWithDigit) continue;

    const start = index;
    let cursor = startsWithPlus ? index + 2 : index + 1;
    while (cursor < normalized.length && isPhoneBodyChar(normalized[cursor])) cursor += 1;

    let end = cursor;
    while (end > start && !isAsciiDigit(normalized[end - 1])) end -= 1;

    const candidate = normalized.slice(start, end);
    if (candidate.length >= 10) return compactPhone(candidate);
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
  const phrases = ['меня зовут', 'зовут', 'имя', 'я'];
  for (const phrase of phrases) {
    for (let index = 0; index < lower.length; index += 1) {
      if (!phraseAt(lower, phrase, index)) continue;
      const name = readName(normalized, index + phrase.length);
      if (name) return name;
    }
  }
  return undefined;
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
  const last = parts[parts.length - 1];
  if (!last || !readNameToken(last, 0) || readNameToken(last, 0)?.end !== last.length) return undefined;

  const beforeLast = parts[parts.length - 2];
  if (beforeLast && readNameToken(beforeLast, 0)?.end === beforeLast.length) {
    return `${beforeLast} ${last}`;
  }
  return last;
}

export function extractContact(text: string): ExtractedContact {
  const normalized = normalizeWhitespace(text);
  const email = extractEmail(normalized);
  const phone = extractPhone(normalized);
  const contactIndexes = [phone ? normalized.indexOf(phone) : -1, email ? normalized.indexOf(email) : -1]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  const contactIndex = contactIndexes[0];
  const name = (extractExplicitName(normalized) ?? extractPrefixName(normalized, contactIndex))?.trim();
  return {
    name: name && name.length >= 2 ? name : undefined,
    phone,
    email
  };
}

export function hasLeadContact(contact: ExtractedContact) {
  return Boolean(contact.phone || contact.email);
}
