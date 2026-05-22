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

export function textMatchesTargetName(value: unknown, targetName: string) {
  const targetTokens = modelIdentifierTokens(targetName);
  if (targetTokens.length) {
    const valueIdentifierTokens = new Set(modelIdentifierTokens(value));
    return targetTokens.every((token) => valueIdentifierTokens.has(token));
  }
  const productText = compactModelText(value);
  const targetText = compactModelText(targetName);
  return targetText.length >= 5 && productText.includes(targetText);
}
