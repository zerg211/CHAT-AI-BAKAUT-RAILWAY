import { describe, expect, it } from 'vitest';

import {
  aiFailureReason,
  aiStageFailure,
  emptyAiGenerationDiagnostics,
  markAiFallback
} from '../src/ai/aiGenerationDiagnostics.js';

describe('AI generation diagnostics', () => {
  it('creates empty diagnostics for all fallback stages', () => {
    expect(emptyAiGenerationDiagnostics()).toEqual({
      needExtractionFallback: { used: false },
      turnPlanningFallback: { used: false },
      answerGenerationFallback: { used: false }
    });
  });

  it('preserves string failure reasons', () => {
    expect(aiFailureReason('no_openai_client', 'fallback_reason')).toBe('no_openai_client');
  });

  it('normalizes Error objects through safe error details', () => {
    expect(aiFailureReason(new Error('planner failed'), 'fallback_reason')).toBe('planner failed');
  });

  it('uses fallback when an object has no useful error details', () => {
    expect(aiFailureReason({}, 'fallback_reason')).toBe('fallback_reason');
  });

  it('marks a provided fallback stage and returns the same entry', () => {
    const diagnostics = emptyAiGenerationDiagnostics();

    const entry = markAiFallback(diagnostics, 'turnPlanningFallback', 'planner_timeout');

    expect(entry).toEqual({ used: true, reason: 'planner_timeout' });
    expect(diagnostics.turnPlanningFallback).toBe(entry);
    expect(diagnostics.needExtractionFallback).toEqual({ used: false });
  });

  it('can produce a fallback entry without mutating diagnostics', () => {
    expect(markAiFallback(undefined, 'answerGenerationFallback', 'answer_empty')).toEqual({
      used: true,
      reason: 'answer_empty'
    });
  });

  it('keeps AI stage failure message format stable', () => {
    expect(aiStageFailure('answer generation', { used: true, reason: 'empty_answer' }).message)
      .toBe('AI answer generation failed: empty_answer');
    expect(aiStageFailure('turn planning').message)
      .toBe('AI turn planning failed: unknown_error');
  });
});
