const POWER_UNIT_RE = '(?:кВт|кВА|kw|kva)';

function parseRuNumber(value: string) {
  const normalized = value.replace(/\s+/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRuNumber(value: number) {
  if (Number.isInteger(value)) return String(value);
  return String(value).replace('.', ',');
}

function sameNumber(a: number, b: number) {
  return Math.abs(a - b) < 0.000001;
}

function normalizeRange(minRaw: string, maxRaw: string, unit: string, separator: 'dash' | 'words') {
  const first = parseRuNumber(minRaw);
  const second = parseRuNumber(maxRaw);
  if (first === null || second === null) return null;

  const min = Math.min(first, second);
  const max = Math.max(first, second);
  const normalizedUnit = unit;

  if (sameNumber(min, max)) {
    return `${formatRuNumber(min)} ${normalizedUnit}`;
  }

  const left = formatRuNumber(min);
  const right = formatRuNumber(max);
  return separator === 'words'
    ? `от ${left} до ${right} ${normalizedUnit}`
    : `${left}–${right} ${normalizedUnit}`;
}

/**
 * Deterministic buyer-visible numeric sanity pass.
 * It does not invent product specs; it only fixes impossible/degenerate power ranges
 * already present in generated answer text, e.g. `4–3,5 кВт` or `5–5 кВт`.
 */
export function sanitizeVisibleAnswerNumbers(answer: string) {
  let sanitized = answer;

  const dashRange = new RegExp(
    `(?<![\\d.,])([0-9]+(?:[,.][0-9]+)?)\\s*[-–—]\\s*([0-9]+(?:[,.][0-9]+)?)\\s*(${POWER_UNIT_RE})(?![\\wа-яё])`,
    'giu'
  );
  sanitized = sanitized.replace(dashRange, (match, minRaw: string, maxRaw: string, unit: string) => {
    return normalizeRange(minRaw, maxRaw, unit, 'dash') ?? match;
  });

  const wordRange = new RegExp(
    `от\\s+([0-9]+(?:[,.][0-9]+)?)\\s+до\\s+([0-9]+(?:[,.][0-9]+)?)\\s*(${POWER_UNIT_RE})(?![\\wа-яё])`,
    'giu'
  );
  sanitized = sanitized.replace(wordRange, (match, minRaw: string, maxRaw: string, unit: string) => {
    return normalizeRange(minRaw, maxRaw, unit, 'words') ?? match;
  });

  return sanitized;
}
