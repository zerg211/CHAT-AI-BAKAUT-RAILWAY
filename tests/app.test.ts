import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('app', () => {
  it('serves healthcheck with configured model', async () => {
    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      answerModel: expect.any(String),
      plannerModel: expect.any(String)
    });
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
  }, 15_000);
});
