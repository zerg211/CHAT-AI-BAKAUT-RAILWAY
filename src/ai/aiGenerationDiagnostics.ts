import { safeError } from './responseUtils.js';

export type AiFallbackDiagnostic = {
  used: boolean;
  reason?: string;
};

export type AiGenerationDiagnostics = {
  needExtractionFallback: AiFallbackDiagnostic;
  turnPlanningFallback: AiFallbackDiagnostic;
  answerGenerationFallback: AiFallbackDiagnostic;
};

export type AiFallbackStage = keyof AiGenerationDiagnostics;

export function emptyAiGenerationDiagnostics(): AiGenerationDiagnostics {
  return {
    needExtractionFallback: { used: false },
    turnPlanningFallback: { used: false },
    answerGenerationFallback: { used: false }
  };
}

export function aiFailureReason(error: unknown, fallback = 'unknown_error') {
  if (typeof error === 'string') return error;
  const details = safeError(error);
  return details.code || details.message || (details.status ? `status_${details.status}` : fallback);
}

export function markAiFallback(diagnostics: AiGenerationDiagnostics | undefined, stage: AiFallbackStage, error: unknown, fallback?: string) {
  const entry = { used: true, reason: aiFailureReason(error, fallback) };
  if (diagnostics) diagnostics[stage] = entry;
  return entry;
}

export function aiStageFailure(stage: string, diagnostic?: AiFallbackDiagnostic): Error {
  return new Error(`AI ${stage} failed: ${diagnostic?.reason ?? 'unknown_error'}`);
}
