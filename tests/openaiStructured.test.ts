import { describe, expect, it } from 'vitest';
import {
  parseJsonObject,
  structuredJsonOutputLimitExhausted,
  structuredJsonRetryDecision,
  structuredJsonRetryOutputTokenLimit
} from '../src/ai/openaiStructured.js';

describe('parseJsonObject', () => {
  it('parses the first complete JSON object and ignores trailing model text', () => {
    expect(parseJsonObject('{"ok":true}\nExtra explanation after the contract.', 'stage')).toEqual({ ok: true });
  });

  it('does not consume a second JSON object as trailing text', () => {
    expect(parseJsonObject('{"first":1}\n{"second":2}', 'stage')).toEqual({ first: 1 });
  });

  it('keeps braces inside JSON strings while finding the object boundary', () => {
    expect(parseJsonObject('prefix {"text":"brace } inside string","nested":{"ok":true}} suffix {not json}', 'stage')).toEqual({
      text: 'brace } inside string',
      nested: { ok: true }
    });
  });

  it('parses markdown fenced JSON without regex-based extraction', () => {
    expect(parseJsonObject('```json\n{"contract":"ok"}\n```', 'stage')).toEqual({ contract: 'ok' });
  });
});

describe('structuredJsonRetryOutputTokenLimit', () => {
  it('does not silently expand the requested output budget by default', () => {
    expect(structuredJsonRetryOutputTokenLimit(800)).toBe(800);
    expect(structuredJsonRetryOutputTokenLimit(3200)).toBe(3200);
  });

  it('uses an explicit cap when the caller reserved a larger retry budget', () => {
    expect(structuredJsonRetryOutputTokenLimit(800, 1800)).toBe(1800);
    expect(structuredJsonRetryOutputTokenLimit(3200, 4000)).toBe(4000);
  });
});

describe('structuredJsonOutputLimitExhausted', () => {
  it('detects an incomplete structured response that exhausted its output cap', () => {
    expect(structuredJsonOutputLimitExhausted({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { output_tokens: 3200 }
    }, 3200)).toBe(true);
    expect(structuredJsonOutputLimitExhausted({
      status: 'completed',
      usage: { output_tokens: 3200 }
    }, 3200)).toBe(false);
  });
});

describe('structuredJsonRetryDecision', () => {
  it('skips a structured retry when the stage cannot reserve enough remaining wall time', () => {
    expect(structuredJsonRetryDecision({
      deadlineAtMs: 10_000,
      minRemainingMs: 6_000,
      nowMs: 5_000
    })).toEqual({ retry: false, reason: 'insufficient_time_budget', remainingMs: 5_000 });
  });

  it('allows a retry only when the signal is active and the minimum wall time remains', () => {
    expect(structuredJsonRetryDecision({
      deadlineAtMs: 12_000,
      minRemainingMs: 6_000,
      nowMs: 5_000
    })).toEqual({ retry: true, reason: 'retry_allowed', remainingMs: 7_000 });
    expect(structuredJsonRetryDecision({ signalAborted: true })).toEqual({ retry: false, reason: 'signal_aborted' });
  });
});
