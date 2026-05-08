import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const started = new Date().toISOString();
const protocolPath = path.join('local-live-tests', `${started.slice(0, 10)}-bakautprof-production-agent-cycle.local.md`);
const failurePath = path.join('local-live-tests', 'production-agent-cycle-failure.json');

const turns = [
  {
    phase: 'unclear_generator_need',
    text: 'Здравствуйте. Нужен генератор для дачи на случай отключений. Точных цифр нет: холодильник, насос, свет и иногда инструмент. Не хочется переплачивать, но и промахнуться по мощности тоже не хочу.'
  },
  {
    phase: 'generic_pump_unknown',
    text: 'Дом обычный, 220 В. Насос не знаю какой, модель сейчас не скажу. Холодильник один, свет LED, иногда болгарка 1,2 кВт. Насос с холодильником могут включиться вместе.'
  },
  {
    phase: 'typed_pump_preliminary_selection',
    text: 'Уточнил: насос скважинный, 220 В, но мощность на шильдике сейчас посмотреть не могу. Уже можно прикинуть варианты генераторов: минимальный и с запасом?'
  },
  {
    phase: 'comparison_and_reserve',
    text: 'А если взять дешевле и почти без запаса, чем рискую на практике? И для редких отключений бензиновый или дизельный выгоднее?'
  },
  {
    phase: 'second_need_plate',
    text: 'Параллельно нужна виброплита для дорожек на участке. Будет плитка, песок, иногда немного щебня. Грузить и таскать чаще буду сам, поэтому слишком тяжелую не хочу.'
  },
  {
    phase: 'plate_use_question',
    text: 'По плите объясните просто: что важнее для моей задачи - вес, глубина уплотнения или размер подошвы?'
  },
  {
    phase: 'generator_operation_question',
    text: 'Вернусь к генератору: нужен ли автозапуск или АВР, если отключения редкие? И что обслуживать, чтобы бензиновый нормально заводился после простоя?'
  },
  {
    phase: 'commercial_question',
    text: 'А доставка и скидка есть? И примерно можно понять порядок суммы за генератор плюс виброплиту, если точные модели еще выбираем?'
  },
  {
    phase: 'contact_refusal_summary',
    text: 'Пока без звонка. Сначала хочу понять по технике: что сейчас брать по генератору, что по виброплите и какие данные еще надо уточнить.'
  }
];

const criticalPatterns = [
  /network error/i,
  /ответ не успел/iu,
  /не успел сформироваться/iu,
  /server finished without a done payload/i,
  /\bundefined\b|\bnull\b/i
];

function latestAssistant(messages) {
  return [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
}

function hasGeneratorCardText(text) {
  return /Генератор\s+бензиновый|Бензиновые генераторы/iu.test(text) && /\d[\d\s]*(?:RUB|₽)/iu.test(text);
}

function assertNoCriticalText(text, phase) {
  for (const pattern of criticalPatterns) {
    if (pattern.test(text)) throw new Error(`Critical failure pattern ${pattern} in ${phase}: ${text}`);
  }
}

function assertPhase(phase, answer, pageText) {
  assertNoCriticalText(answer, phase);
  const combined = `${answer}\n${pageText}`;

  if (phase === 'generic_pump_unknown') {
    if (hasGeneratorCardText(combined)) {
      throw new Error('Generic unknown pump produced generator cards before pump type or power was known.');
    }
    if (!/(тип|какой).{0,80}насос|насос.{0,80}(мощност|модель|шильдик|тип)/iu.test(answer)) {
      throw new Error(`Generic pump answer did not ask for pump type/model/power: ${answer}`);
    }
  }

  if (phase === 'typed_pump_preliminary_selection') {
    if (!hasGeneratorCardText(combined)) {
      throw new Error('Typed pump context did not produce preliminary generator cards.');
    }
    if (!/(предвар|мощност|модель|шильдик|точн)/iu.test(answer)) {
      throw new Error(`Typed pump selection did not mark the recommendation as preliminary/needs pump check: ${answer}`);
    }
  }

  if (phase === 'comparison_and_reserve') {
    if (!/бензин/iu.test(answer) || !/дизел/iu.test(answer) || !/(запас|пуск|перегруз|напряж)/iu.test(answer)) {
      throw new Error(`Comparison did not cover gasoline/diesel and reserve risk: ${answer}`);
    }
    if (/режущие диски|водяной узел/iu.test(answer)) {
      throw new Error(`Generator comparison included irrelevant consumables: ${answer}`);
    }
  }

  if (phase === 'commercial_question') {
    if (/ориентир.{0,80}сумм/iu.test(answer) && !/генератор/iu.test(answer)) {
      throw new Error(`Bundle total was stated without selected generator context: ${answer}`);
    }
    if (!/(доставк|логист|менеджер|услов)/iu.test(answer)) {
      throw new Error(`Commercial answer did not separate delivery/discount conditions: ${answer}`);
    }
  }

  if (phase === 'contact_refusal_summary') {
    if (/остав(ь|ьте).{0,80}(телефон|номер|контакт)|напишите.{0,80}(телефон|номер)/iu.test(answer)) {
      throw new Error(`Lead pressure after contact refusal: ${answer}`);
    }
    if (!/генератор/iu.test(answer) || !/виброплит/iu.test(answer)) {
      throw new Error(`Final summary lost generator or plate need: ${answer}`);
    }
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

async function main() {
  await fs.mkdir('local-live-tests', { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: await resolveBrowserExecutable()
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const steps = [];

  try {
    await page.goto('https://bakautprof.ru/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const iframeElement = page.locator('iframe[src*="chat-ai-production"], iframe[src*="railway"], iframe[src*="/widget"]').first();
    await iframeElement.waitFor({ state: 'attached', timeout: 60_000 });
    const frame = await iframeElement.contentFrame();
    if (!frame) throw new Error('Chat iframe frame was not available.');

    await frame.getByRole('button').filter({ hasText: /чат|консультант|задать|написать/i }).first().click({ timeout: 20_000 }).catch(() => undefined);
    const input = frame.locator('textarea, input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: 60_000 });

    for (const turn of turns) {
      await input.waitFor({ state: 'visible', timeout: 60_000 });
      await waitInputEnabled(input);
      await input.fill(turn.text);
      await input.press('Enter');
      await waitInputEnabled(input);
      await page.waitForTimeout(1000);

      const messages = await collectMessages(frame);
      const answer = latestAssistant(messages);
      const pageText = await frame.locator('body').innerText().catch(() => '');
      if (!answer) throw new Error(`Empty assistant answer after ${turn.phase}`);
      assertPhase(turn.phase, answer, pageText);
      steps.push({ phase: turn.phase, user: turn.text, assistant: answer });
    }

    const transcript = steps.map((step) => `${step.user}\n${step.assistant}`).join('\n\n');
    if (!/генератор/iu.test(transcript)) throw new Error('Generator need was lost.');
    if (!/виброплит/iu.test(transcript)) throw new Error('Plate need was lost.');

    await fs.writeFile(protocolPath, [
      '# Production embedded widget live agent-cycle',
      '',
      `URL: https://bakautprof.ru/`,
      `Date: ${new Date().toISOString()}`,
      '',
      ...steps.flatMap((step, index) => [
        `## Turn ${index + 1}: ${step.phase}`,
        '',
        `**User:** ${step.user}`,
        '',
        `**Assistant:** ${step.assistant}`
      ]),
      '',
      '## Audit',
      '',
      '- PASS: full production iframe path completed.',
      '- PASS: generic unknown pump did not produce generator cards.',
      '- PASS: typed pump produced only preliminary generator selection.',
      '- PASS: comparison, multi-need memory, commercial handoff, and contact refusal checks passed.'
    ].join('\n'), 'utf8');

    console.log(`PASS production live agent cycle. Protocol: ${protocolPath}`);
  } catch (error) {
    await fs.writeFile(failurePath, JSON.stringify({ error: String(error), steps }, null, 2), 'utf8');
    throw error;
  } finally {
    await browser.close();
  }
}

main();
