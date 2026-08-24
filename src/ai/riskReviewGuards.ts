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

// Blocking flags must be exact contract vocabulary, not substrings. A flag like
// `web_fact_unverified_kept_preliminary` honestly marks a handled gap (preliminary
// recommendation with caveat — encouraged by AGENTS.md) and must NOT kill the answer.
// Only flags asserting a confirmed-style claim without evidence are blocking.
const blockingUnsupportedClaimFlags = new Set([
  'unsupportedclaim',
  'unverifiedclaimpresentedasconfirmed',
  'noevidenceclaim',
  'hallucinationrisk'
]);

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
  return riskFlags.some((flag) => blockingUnsupportedClaimFlags.has(normalizedSignal(flag)));
}
