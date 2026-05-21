import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../src/shared/types.js';
import {
  compactHistoryForAI,
  createStructuredJsonResponse,
  jsonOutputTokenLimit,
  parseJsonObject,
  responseTextForJson,
  truncateForAI
} from '../src/ai/assistantStructuredJson.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assistant structured JSON helpers', () => {
  it('keeps assistant prompt input compaction stable', () => {
    const history = [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'second message' },
      { role: 'user', content: '  abcdefghij  ' }
    ] as Message[];

    expect(truncateForAI('  abcdefghij  ', 6)).toBe('abcdef...');
    expect(compactHistoryForAI(history, 2, 6)).toEqual([
      { role: 'assistant', content: 'second...' },
      { role: 'user', content: 'abcdef...' }
    ]);
    expect(jsonOutputTokenLimit(100)).toBe(2400);
    expect(jsonOutputTokenLimit(3000)).toBe(3000);
  });

  it('parses plain and fenced JSON without regex-based fence stripping', () => {
    expect(parseJsonObject('{"ok":true}', 'stage')).toEqual({ ok: true });
    expect(parseJsonObject('```json\n{"contract":"ok"}\n```', 'stage')).toEqual({ contract: 'ok' });
    expect(parseJsonObject('```\n{"contract":"ok"}\n```', 'stage')).toEqual({ contract: 'ok' });
  });

  it('keeps stage-specific parse errors', () => {
    try {
      parseJsonObject('', 'need_extraction');
      throw new Error('expected empty JSON error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('need_extraction returned empty JSON');
    }

    try {
      parseJsonObject('not json', 'turn_planner');
      throw new Error('expected invalid JSON error');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message.startsWith('turn_planner returned invalid JSON:')).toBe(true);
    }
  });

  it('extracts response text using the same output precedence', () => {
    expect(responseTextForJson({ output_text: ' {"ok":true} ' })).toBe(' {"ok":true} ');
    expect(responseTextForJson({
      output: [{
        content: [{ text: '{"from":"direct"}' }]
      }]
    })).toBe('{"from":"direct"}');
  });

  it('retries structured response parsing with the same output token floor', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      responses: {
        create: vi.fn(async (body: Record<string, unknown>) => {
          requests.push(body);
          return requests.length === 1
            ? { output_text: 'not json' }
            : { output_text: '{"ok":true}' };
        })
      }
    };

    const result = await createStructuredJsonResponse(client, {
      model: 'test-model',
      input: 'Return JSON',
      max_output_tokens: 10
    }, 'assistant_stage');

    expect(result.parsed).toEqual({ ok: true });
    expect(client.responses.create).toHaveBeenCalledTimes(2);
    expect(requests[1].max_output_tokens).toBe(12000);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
