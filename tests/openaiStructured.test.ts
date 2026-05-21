import { describe, expect, it } from 'vitest';
import { parseJsonObject } from '../src/ai/openaiStructured.js';

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
