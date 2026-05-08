import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const widgetUrl = process.env.LOCAL_WIDGET_URL || 'http://localhost:3010/widget';
const protocolPath = path.join('local-live-tests', `${new Date().toISOString().slice(0, 10)}-local-household-generator-minimum.local.md`);
const failurePath = path.join('local-live-tests', 'local-household-generator-minimum.failure.json');

const turns = [
  {
    phase: 'unclear_need',
    text: 'Здравствуйте. Нужен генератор для дачи на отключения. Точных цифр нет: холодильник, насос, LED свет и иногда болгарка. Хочу минимально достаточно, без лишней переплаты.'
  },
  {
    phase: 'generic_pump_unknown',
    text: 'Дом 220 В. Холодильник один, болгарка 1,2 кВт, свет LED. Насос не знаю какой и мощность не знаю, но насос с холодильником могут включиться вместе.'
  },
  {
    phase: 'typed_pump_minimum',
    text: 'Уточнил: насос скважинный 220 В, но шильдик сейчас не посмотреть. Посчитайте минимально достаточный класс генератора, не с огромным запасом.'
  },
  {
    phase: 'post_start_remaining',
    text: 'Если взять генератор 5,5 кВт, после запуска насоса и холодильника можно будет еще подключить болгарку 1,2 кВт и LED свет? Сколько примерно останется?'
  }
];

async function collectMessages(page) {
  return page.locator('.message').evaluateAll((nodes) => nodes.map((node) => ({
    role: node.classList.contains('assistant') ? 'assistant' : node.classList.contains('user') ? 'user' : 'system',
    text: node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })));
}

function latestAssistant(messages) {
  return [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
}

async function waitInputEnabled(input, timeoutMs = 190_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await input.isEnabled().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Chat input did not become enabled.');
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

function assertNoCritical(answer, phase, pageText = '') {
  const text = `${answer}\n${pageText}`;
  if (/network error|AI FALLBACK|Connection error|ответ не успел|не успел сформироваться|undefined|null/i.test(text)) {
    throw new Error(`Critical text in ${phase}: ${text}`);
  }
}

function hasGeneratorCardText(text) {
  return /(?:открыть карточку|показано\s+\d+|показать еще)/iu.test(text) &&
    /(?:генератор|бензогенератор|электростанц)/iu.test(text) &&
    /(?:\d[\d\s]*(?:₽|руб|RUB)|кВт|kw)/iu.test(text);
}

function hasConcreteGeneratorModelText(text) {
  return /(?:SUMEC|BISON|CHAMPION|A-iPower|DAEWOO|FUBAG|Huter|ТСС|TOR|EUROPOWER|Honda|Patriot|Zitrek)/iu.test(text) &&
    /(?:генератор|бензогенератор|электростанц|\d+(?:[,.]\d+)?\s*(?:кВт|kw))/iu.test(text);
}

function assertSizing(answer, pageText, phase) {
  assertNoCritical(answer, phase, pageText);
  const combined = `${answer}\n${pageText}`;
  if ((phase === 'unclear_need' || phase === 'generic_pump_unknown') && (hasGeneratorCardText(pageText) || hasConcreteGeneratorModelText(answer))) {
    throw new Error(`Generic unknown pump produced generator model/cards before pump type/power was known: ${combined}`);
  }
  if (phase === 'typed_pump_minimum') {
    if (!/(4[,.]?5|5|5[,.]5)\s*(?:кВт|kw)/iu.test(answer)) {
      throw new Error(`No minimally sufficient 4.5/5/5.5 kW class in answer: ${answer}`);
    }
    if (/(?:минимум|надо|брать|рекоменд|лучше|идеал)[^.?!\n]{0,100}(?:6\s*[–—-]\s*8|7\s*[–—-]\s*8|8[,.]?5)\s*(?:кВт|kw)/iu.test(answer)) {
      throw new Error(`Inflated 6-8/8.5 kW recommendation in answer: ${answer}`);
    }
    if (!hasGeneratorCardText(combined)) {
      throw new Error(`Typed pump sizing did not show preliminary generator cards: ${combined}`);
    }
  }
  if (phase === 'post_start_remaining') {
    if (!/(после|работ)[^.?!\n]{0,120}(остан|свобод|запас)|болгарк|1[,.]2/iu.test(answer)) {
      throw new Error(`Post-start answer did not reason about remaining/running load: ${answer}`);
    }
  }
}

async function main() {
  await fs.mkdir('local-live-tests', { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: await resolveBrowserExecutable()
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const steps = [];

  try {
    await page.goto(widgetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByRole('button').filter({ hasText: /чат|консультант|задать|написать/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
    const input = page.locator('textarea, input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: 60_000 });

    for (const turn of turns) {
      await waitInputEnabled(input);
      await input.fill(turn.text);
      await input.press('Enter');
      await waitInputEnabled(input);
      await page.waitForTimeout(1000);
      const messages = await collectMessages(page);
      const answer = latestAssistant(messages);
      const pageText = await page.locator('body').innerText().catch(() => '');
      if (!answer) throw new Error(`Empty answer after ${turn.phase}`);
      assertSizing(answer, pageText, turn.phase);
      steps.push({ ...turn, assistant: answer, pageText });
    }

    await fs.writeFile(protocolPath, [
      '# Local live household generator minimum sizing',
      '',
      `URL: ${widgetUrl}`,
      `Date: ${new Date().toISOString()}`,
      '',
      ...steps.flatMap((step, index) => [
        `## Turn ${index + 1}: ${step.phase}`,
        '',
        `**User:** ${step.text}`,
        '',
        `**Assistant:** ${step.assistant}`,
        '',
        `<details><summary>Page text</summary>`,
        '',
        step.pageText,
        '',
        `</details>`,
        ''
      ]),
      '## Audit',
      '',
      '- PASS: local UI dialogue completed.',
      '- PASS: generic unknown pump did not show generator models or cards.',
      '- PASS: typed pump sizing showed preliminary generator cards.',
      '- PASS: typed pump household load did not turn reserve into 6-8 kW minimum.',
      '- PASS: post-start question was answered as running/remaining-load reasoning.'
    ].join('\n'), 'utf8');
    console.log(`PASS local live household generator minimum sizing. Protocol: ${protocolPath}`);
  } catch (error) {
    await fs.writeFile(failurePath, JSON.stringify({ error: String(error), steps }, null, 2), 'utf8');
    throw error;
  } finally {
    await browser.close();
  }
}

main();
