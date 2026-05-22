import { describe, expect, it } from 'vitest';
import { extractResponseText, extractUrlCitations, responseUsedWebSearch } from '../src/ai/responseUtils.js';

describe('response utils provider type parsing', () => {
  it('detects web search provider nodes without regex', () => {
    expect(responseUsedWebSearch({
      output: [
        { type: 'response.web_search_call.completed', id: 'call-1' }
      ]
    })).toBe(true);
  });

  it('extracts nested response text from known text node types', () => {
    expect(extractResponseText({
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: '  Проверенный ответ по каталогу.  ' }
          ]
        }
      ]
    })).toBe('Проверенный ответ по каталогу.');
  });

  it('does not read arbitrary text fields from unknown typed nodes', () => {
    expect(extractResponseText({
      output: [
        { type: 'debug_payload', text: 'internal trace only' }
      ]
    })).toBe('');
  });

  it('extracts URL citations and removes duplicates', () => {
    const citations = extractUrlCitations({
      output: [
        {
          type: 'url_citation',
          url: 'https://example.test/manual',
          title: 'Manual',
          snippet: 'spec'
        },
        {
          type: 'search_result',
          url: 'https://example.test/manual',
          title: 'Duplicate'
        },
        {
          type: 'web_search_result',
          url: 'https://example.test/catalog'
        }
      ]
    });

    expect(citations).toEqual([
      {
        url: 'https://example.test/manual',
        title: 'Manual',
        snippet: 'spec'
      },
      {
        url: 'https://example.test/catalog',
        title: undefined,
        snippet: undefined
      }
    ]);
  });
});
