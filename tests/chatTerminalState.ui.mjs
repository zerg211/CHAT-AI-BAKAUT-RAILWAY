import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Frontend state test only: every API request is mocked, including failed recovery.
const server = await createServer({ server: { host: '127.0.0.1', port: 5198, strictPort: false }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage();
  let releaseFailure;
  const failureGate = new Promise(resolve => { releaseFailure = resolve; });
  let submits = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/sessions')) return route.fulfill({ json: { session: { id: 'ui-test-session', visitorId: 'synthetic-ui-test-visitor' } } });
    if (pathname.endsWith('/heartbeat')) return route.fulfill({ json: { ok: true } });
    if (pathname.endsWith('/messages') && request.method() === 'GET') return route.fulfill({ json: { messages: [], pendingTurn: { turnId: 'ui-test-turn', status: 'failed', resultState: 'failed' } } });
    if (pathname.endsWith('/messages') && request.method() === 'POST') {
      submits += 1;
      if (submits === 1) {
        await failureGate;
        return route.fulfill({ contentType: 'text/event-stream', body: 'event: error\ndata: {"error":"Не удалось подготовить ответ","recoverable":false}\n\n' });
      }
      return route.fulfill({ contentType: 'text/event-stream', body: 'event: done\ndata: {"answer":"Подскажите площадь участка и как будете перевозить оборудование.","assistantMessageId":"ui-test-answer","productCards":[]}\n\n' });
    }
    throw new Error(`Unexpected mocked endpoint: ${request.method()} ${pathname}`);
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  const input = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  await input.fill('Нужна техника для участка');
  await input.press('Enter');
  await page.locator('.typing').waitFor({ state: 'visible' });
  assert.equal(await input.isEnabled(), false, 'input stays disabled during an active answer');
  releaseFailure();
  await page.locator('.error').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.composer textarea').disabled);
  assert.equal(await page.locator('.typing').count(), 0, 'terminal failure must not still claim the assistant is typing');
  assert.equal(await page.locator('.message.user').count(), 1, 'failed attempt preserves the buyer message');
  await input.fill('Площадь 40 квадратных метров');
  await input.press('Enter');
  await page.getByText('Подскажите площадь участка и как будете перевозить оборудование.', { exact: true }).waitFor();
  assert.equal(await page.locator('.error').count(), 0, 'successful next answer clears the previous error');
  assert.equal(await page.locator('.typing').count(), 0);
  assert.equal(submits, 2, 'one request per deliberate buyer submission');
  console.log('PASS: active -> terminal failure -> successful next answer; all API responses mocked; no OpenAI calls');
} finally {
  await browser?.close();
  await server.close();
}
