import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat route SSE abort policy', () => {
  it('does not attach request/reply close abort handlers to streaming chat turns', () => {
    const source = readFileSync('src/routes/chat.ts', 'utf8');

    expect(source).not.toMatch(/reply\.raw\.once\(['"]close['"]/);
    expect(source).not.toMatch(/request\.raw\.once\(['"]close['"]/);
    expect(source).not.toMatch(/request\.raw\.once\(['"]aborted['"]/);
    expect(source).toContain('const timeout = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS)');
  });
});
