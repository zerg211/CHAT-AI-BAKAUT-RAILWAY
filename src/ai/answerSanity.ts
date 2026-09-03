interface RangeMatch {
  text: string;
  end: number;
}

const POWER_UNITS = ['квт', 'ква', 'kva', 'kw'];

function isDigitChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isNumberChar(ch: string): boolean {
  return isDigitChar(ch) || ch === '.' || ch === ',';
}

function isSpaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ';
}

function isWordChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 90) return true;
  if (code >= 97 && code <= 122) return true;
  if (ch === '_') return true;
  if (code >= 0x0410 && code <= 0x044f) return true;
  if (code === 0x0401 || code === 0x0451) return true;
  return false;
}

function isLetterOrDigitChar(ch: string): boolean {
  return isWordChar(ch) && ch !== '_';
}

function isDashChar(ch: string): boolean {
  return ch === '-' || ch === '–' || ch === '—';
}

function skipSpaces(text: string, index: number): number {
  let i = index;
  while (i < text.length && isSpaceChar(text[i])) i++;
  return i;
}

function parseDecimalNumber(text: string, index: number): { value: number; end: number } | null {
  let i = index;
  let intPart = '';
  while (i < text.length && isDigitChar(text[i])) {
    intPart += text[i];
    i++;
  }
  if (!intPart) return null;
  let fracPart = '';
  if (i < text.length && (text[i] === '.' || text[i] === ',')) {
    let j = i + 1;
    let frac = '';
    while (j < text.length && isDigitChar(text[j])) {
      frac += text[j];
      j++;
    }
    if (frac) {
      fracPart = frac;
      i = j;
    }
  }
  const value = Number(fracPart ? `${intPart}.${fracPart}` : intPart);
  if (!Number.isFinite(value)) return null;
  return { value, end: i };
}

function matchPowerUnit(text: string, index: number): { text: string; end: number } | null {
  const three = text.slice(index, index + 3).toLowerCase();
  if (three === 'квт' || three === 'ква' || three === 'kva') {
    return { text: text.slice(index, index + 3), end: index + 3 };
  }
  const two = text.slice(index, index + 2).toLowerCase();
  if (two === 'kw') {
    return { text: text.slice(index, index + 2), end: index + 2 };
  }
  return null;
}

function matchKeyword(text: string, index: number, word: string): boolean {
  return text.slice(index, index + word.length).toLowerCase() === word;
}

function formatRuNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(value).replace('.', ',');
}

function normalizeRangeValues(first: number, second: number, unit: string, separator: 'dash' | 'words'): string {
  const min = Math.min(first, second);
  const max = Math.max(first, second);
  if (Math.abs(min - max) < 0.000001) {
    return `${formatRuNumber(min)} ${unit}`;
  }
  const left = formatRuNumber(min);
  const right = formatRuNumber(max);
  return separator === 'words'
    ? `от ${left} до ${right} ${unit}`
    : `${left}–${right} ${unit}`;
}

function tryDashRange(text: string, index: number): RangeMatch | null {
  if (!isDigitChar(text[index])) return null;
  if (index > 0 && isNumberChar(text[index - 1])) return null;
  const first = parseDecimalNumber(text, index);
  if (!first) return null;
  const dashIndex = skipSpaces(text, first.end);
  if (dashIndex >= text.length || !isDashChar(text[dashIndex])) return null;
  const secondStart = skipSpaces(text, dashIndex + 1);
  if (secondStart >= text.length || !isDigitChar(text[secondStart])) return null;
  const second = parseDecimalNumber(text, secondStart);
  if (!second) return null;
  const unitStart = skipSpaces(text, second.end);
  const unit = matchPowerUnit(text, unitStart);
  if (!unit) return null;
  if (unit.end < text.length && isWordChar(text[unit.end])) return null;
  return { text: normalizeRangeValues(first.value, second.value, unit.text, 'dash'), end: unit.end };
}

function tryWordRange(text: string, index: number): RangeMatch | null {
  if (!matchKeyword(text, index, 'от')) return null;
  if (index > 0 && isLetterOrDigitChar(text[index - 1])) return null;
  let cursor = skipSpaces(text, index + 2);
  if (cursor >= text.length || !isSpaceChar(text[index + 2]) || !isDigitChar(text[cursor])) return null;
  const first = parseDecimalNumber(text, cursor);
  if (!first) return null;
  cursor = skipSpaces(text, first.end);
  if (!matchKeyword(text, cursor, 'до')) return null;
  const afterDo = cursor + 2;
  if (afterDo >= text.length || !isSpaceChar(text[afterDo])) return null;
  cursor = skipSpaces(text, afterDo);
  if (cursor >= text.length || !isDigitChar(text[cursor])) return null;
  const second = parseDecimalNumber(text, cursor);
  if (!second) return null;
  const unit = matchPowerUnit(text, skipSpaces(text, second.end));
  if (!unit) return null;
  if (unit.end < text.length && isWordChar(text[unit.end])) return null;
  return { text: normalizeRangeValues(first.value, second.value, unit.text, 'words'), end: unit.end };
}

/**
 * Deterministic buyer-visible numeric sanity pass.
 * It does not invent product specs; it only fixes impossible/degenerate power ranges
 * already present in generated answer text, e.g. `4–3,5 кВт` or `5–5 кВт`.
 * Implemented with explicit character scanning (no regex) to stay within the no-regex gate.
 */
export function sanitizeVisibleAnswerNumbers(answer: string): string {
  if (!answer) return answer;
  let result = '';
  let i = 0;
  while (i < answer.length) {
    const dashMatch = tryDashRange(answer, i);
    if (dashMatch) {
      result += dashMatch.text;
      i = dashMatch.end;
      continue;
    }
    const wordMatch = tryWordRange(answer, i);
    if (wordMatch) {
      result += wordMatch.text;
      i = wordMatch.end;
      continue;
    }
    result += answer[i];
    i++;
  }
  return result;
}
