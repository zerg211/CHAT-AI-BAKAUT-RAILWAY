import type { ToolResult } from './agentManagerContracts.js';

function normalizedSignal(value: string) {
  let normalized = '';
  for (const char of value.toLocaleLowerCase('ru-RU')) {
    if (char === '_' || char === '-' || char === ' ') continue;
    normalized += char;
  }
  return normalized;
}

function containsAnySignal(value: string, signals: string[]) {
  const normalized = normalizedSignal(value);
  return signals.some((signal) => normalized.includes(signal));
}

const answerAdjudicationSignals = [
  'highriskdisagreement',
  'needadjudication',
  'needsadjudication',
  'requireadjudication',
  'requiresadjudication',
  'sourceconflictunresolved'
];

const toolAdjudicationSignals = [
  'highriskdisagreement',
  'unresolvedconflict',
  'needadjudication',
  'needsadjudication',
  'requireadjudication',
  'requiresadjudication'
];

const unsupportedClaimSignals = [
  'unsupported',
  'unverified',
  'noevidence',
  'hallucination'
];

export function hasAdjudicationRisk(input: {
  answerRiskFlags: string[];
  toolResults: ToolResult[];
}) {
  return input.answerRiskFlags.some((flag) => containsAnySignal(flag, answerAdjudicationSignals)) ||
    input.toolResults.some((result) =>
      result.warnings.some((warning) => containsAnySignal(warning, toolAdjudicationSignals))
    );
}

export function hasUnsupportedClaimRisk(riskFlags: string[]) {
  return riskFlags.some((flag) => containsAnySignal(flag, unsupportedClaimSignals));
}
