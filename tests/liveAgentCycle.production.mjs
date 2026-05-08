import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const turns = [
  'Здравствуйте. Нужен генератор для дачи, но точные данные не знаю: холодильник, насос, свет, иногда инструмент.',
  'Дом обычный 220 В. Насос не знаю какой, холодильник один, свет LED, иногда болгарка. Хочу без лишней переплаты.',
  'А если взять дешевле и почти без запаса, чем рискую? И сравните бензиновый и дизельный для редких отключений.',
  'Параллельно нужна виброплита для дорожек на участке. Плитка и песок, иногда щебень, таскать буду сам.',
  'По виброплите что важнее: вес, глубина уплотнения или размер подошвы? Хочу понять эксплуатацию.',
  'По генератору нужен ли автозапуск или АВР, если отключения редкие? Что придется обслуживать?',
  'Есть ли доставка и скидка, и можно ли понять примерную сумму комплекта без точного заказа?',
  'Номер пока не оставляю. Сначала дайте финальный итог: генератор отдельно, виброплита отдельно, что еще уточнить.',
  'И коротко: что бы вы выбрали как менеджер, если я не хочу переплатить, но хочу без явного риска?'
];

const criticalPatterns = [
  /network error/i,
  /ответ не успел/i,
  /не успел сформироваться/i,
  /server finished without a done payload/i,
  /undefined|null/i
];

function latestAssistant(messages) {
  return [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
}

function assertNoCriticalFailures(messages) {
  const transcript = messages.map((message) => message.text).join('\n\n');
  for (const pattern of criticalPatterns) {
    if (pattern.test(transcript)) throw new Error(`Critical failure pattern found: ${pattern}`);
  }
  if (!/генератор/i.test(transcript)) throw new Error('Generator need was lost.');
  if (!/виброплит/i.test(transcript)) throw new Error('Plate need was lost.');
  if (/номер пока не оставляю/i.test(transcript) && /оставьте.{0,80}(телефон|номер|контакт)/iu.test(latestAssistant(messages))) {
    throw new Error('Lead pressure after explicit contact refusal.');
  }
  const commercialAnswer = messages.find((message) =>
    message.role === 'assistant' &&
    /доставк|скидк|сумм|комплект|логист/iu.test(message.text)
  );
  if (commercialAnswer && /ориентир.{0,80}сумм/iu.test(commercialAnswer.text) && !/генератор/iu.test(commercialAnswer.text)) {
    throw new Error('Bundle total was stated without a selected generator in the same commercial answer.');
  }
  const comparisonTurn = messages.find((message) => message.role === 'assistant' && /бензин|дизел|запас/iu.test(message.text));
  if (!comparisonTurn) throw new Error('No assistant answer covered gasoline/diesel or reserve risk.');
  if (/наш[её]л[ао]?\s+\d+\s+(?:позиц|вариант|товар)/iu.test(comparisonTurn.text) && !/бензин|дизел|запас/iu.test(comparisonTurn.text)) {
    throw new Error('Comparison was replaced by catalog shortlist.');
  }
}

async function waitInputEnabled(input, timeoutMs = 190_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await input.isEnabled().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Chat input did not become enabled before timeout.');
}

async function collectMessages(frame) {
  return frame.locator('.message').evaluateAll((nodes) => nodes.map((node) => ({
    role: node.classList.contains('assistant') ? 'assistant' : node.classList.contains('user') ? 'user' : 'system',
    text: node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })));
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: await resolveBrowserExecutable()
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const messages = [];
  try {
    await page.goto('https://bakautprof.ru/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const iframeElement = await page.locator('iframe[src*="chat-ai-production"], iframe[src*="railway"], iframe[src*="/widget"]').first();
    await iframeElement.waitFor({ state: 'attached', timeout: 60_000 });
    const frame = await iframeElement.contentFrame();
    if (!frame) throw new Error('Chat iframe frame was not available.');

    const openButton = frame.getByRole('button').filter({ hasText: /чат|консультант|задать|написать/i }).first();
    await openButton.click({ timeout: 20_000 }).catch(() => undefined);
    const input = frame.locator('textarea, input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: 60_000 });

    for (const turn of turns) {
      await input.waitFor({ state: 'visible', timeout: 60_000 });
      await waitInputEnabled(input);
      await input.fill(turn);
      await input.press('Enter');
      await waitInputEnabled(input);
      await page.waitForTimeout(1000);
      const currentMessages = await collectMessages(frame);
      messages.splice(0, messages.length, ...currentMessages);
      const answer = latestAssistant(messages);
      if (!answer || criticalPatterns.some((pattern) => pattern.test(answer))) {
        throw new Error(`Critical assistant answer after turn "${turn}": ${answer}`);
      }
      if (/доставк|скидк|сумм|комплект/iu.test(turn) && /ориентир.{0,80}сумм/iu.test(answer) && !/генератор/iu.test(answer)) {
        throw new Error(`Bundle total was stated without selected generator after commercial turn: ${answer}`);
      }
    }

    assertNoCriticalFailures(messages);
    await fs.mkdir('local-live-tests', { recursive: true });
    const file = path.join('local-live-tests', `${new Date().toISOString().slice(0, 10)}-bakautprof-production-agent-cycle.local.md`);
    await fs.writeFile(file, [
      '# Production embedded widget live agent-cycle',
      '',
      `URL: https://bakautprof.ru/`,
      `Date: ${new Date().toISOString()}`,
      '',
      ...messages.map((message) => `**${message.role}:** ${message.text}`)
    ].join('\n\n'), 'utf8');
    console.log(`PASS production live agent cycle. Protocol: ${file}`);
  } catch (error) {
    await fs.mkdir('local-live-tests', { recursive: true });
    await fs.writeFile(path.join('local-live-tests', 'production-agent-cycle-failure.json'), JSON.stringify({ error: String(error), messages }, null, 2), 'utf8');
    throw error;
  } finally {
    await browser.close();
  }
}

async function resolveBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next local browser
    }
  }
  return undefined;
}

main();
