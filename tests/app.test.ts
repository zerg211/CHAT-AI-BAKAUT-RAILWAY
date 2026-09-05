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
        version: '2026-09-05.autonomous-consultation-v3',
        contractVersion: '2026-08-11.manager-contract-v2',
        productionRuntime: 'agent_manager'
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
    expect(response.body).toContain('bakautAiQuestion');
    expect(response.body).toContain('bakaut-ai-widget-prompt');
    expect(response.body).toContain('right:32px');
    expect(response.body).toContain('min-width:144px;width:144px;height:144px');
    expect(response.body).toContain('min-width:68px;width:68px;height:68px');
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
