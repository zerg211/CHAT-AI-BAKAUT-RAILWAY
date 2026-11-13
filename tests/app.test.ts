import { describe, expect, it } from 'vitest';
import { buildApp, corsOriginsForEnvironment } from '../src/app.js';

describe('app', () => {
  it('does not reflect arbitrary origins in production defaults', () => {
    expect(corsOriginsForEnvironment({
      nodeEnv: 'production',
      publicBaseUrl: 'https://chat.example.test',
      catalogBaseUrl: 'https://bakautprof.ru'
    })).toEqual(['https://chat.example.test', 'https://bakautprof.ru']);
  });

  it('serves a minimal public deployment health marker without operational diagnostics', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      runtime: {
        version: '2026-11-03.platform-agent-v1',
        contractVersion: '2026-11-03.catalog-snapshot-v1',
        productionRuntime: 'openai_platform_agent'
      }
    });
    expect(response.json()).not.toHaveProperty('answerModel');
    expect(response.json()).not.toHaveProperty('plannerModel');
    expect(response.json()).not.toHaveProperty('operations');
    expect(response.json().runtime).not.toHaveProperty('branch');
    expect(response.json().runtime).not.toHaveProperty('decision');
    expect(response.json().runtime).not.toHaveProperty('manifest');
  }, 15_000);

  it('rejects oversized JSON bodies before public route validation or persistence', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      payload: { visitorId: 'x'.repeat(2 * 1024 * 1024 + 1) }
    });
    await app.close();

    expect(response.statusCode).toBe(413);
  }, 15_000);

  it('serves a launcher widget script compatible with old embed snippets', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/widget.js' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/javascript');
    expect(response.body).toContain('bakaut-ai-widget-launcher');
    expect(response.body).toContain('data.chatSrc');
    expect(response.body).toContain('/widget?pageUrl=');
    expect(response.body).toContain('bakaut-ai-open');
    expect(response.body).toContain('pointer-events:none');
    expect(response.body).toContain('pointer-events:auto');
    expect(response.body).toContain('ЧАТ ПО ТЕХНИКЕ');
    expect(response.body).toContain('Подбор • сравнение • вопросы');
    expect(response.body).toContain('right:32px');
    expect(response.body).toContain('width:320px;height:128px');
    expect(response.body).toContain('width:min(270px,calc(100vw - 24px))');
    expect(response.body).toContain('bottom:calc(74px + env(safe-area-inset-bottom,0px))');
    expect(response.body).toContain('trimTrailingSlashes(data.chatSrc');
    expect(response.body).toContain('while (text.endsWith');
    expect(response.body).toContain('function pixelNumber');
    expect(response.body).toContain("sizeAtLeast(data.width, '640px', 640)");
    expect(response.body).toContain("sizeAtLeast(data.height, '820px', 820)");
    expect(response.body).toContain('px !== null && px < minPx');
    expect(response.body).toContain('var replacements =');
  }, 15_000);
});
