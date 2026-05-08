import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Client } = pg;
const started = new Date().toISOString();
const widgetUrl = process.env.LOCAL_WIDGET_URL || 'http://localhost:3022/widget';
const protocolPath = path.join('local-live-tests', `${started.slice(0, 10)}-local-full-agent-cycle-llm.local.md`);
const failurePath = path.join('local-live-tests', 'local-full-agent-cycle-llm.failure.json');

const phases = [
  {
    phase: 'unclear_generator_need',
    makeText: () => 'Здравствуйте. Нужен генератор для дачи на случай отключений. Точных цифр пока нет: холодильник, свет, насос и иногда болгарка. Хочу без лишней переплаты, но чтобы не промахнуться по мощности.'
  },
  {
    phase: 'load_details_with_unknown_pump_power',
    makeText: () => 'Дом обычный, 220 В. Холодильник один, свет LED, болгарка 1,2 кВт. Насос скважинный, мощность сейчас не знаю. Насос и холодильник могут включиться вместе.'
  },
  {
    phase: 'preliminary_generator_selection',
    makeText: () => 'Понял. Тогда какие варианты генераторов из каталога можно смотреть предварительно? Бюджет примерно до 80-90 тысяч, но без огромного запаса.'
  },
  {
    phase: 'running_load_after_start',
    makeText: () => 'Если взять генератор около 5-5,5 кВт: после запуска насоса и холодильника сколько мощности примерно останется? Болгарку 1,2 кВт и LED свет можно включить потом?'
  },
  {
    phase: 'reserve_and_fuel_comparison',
    makeText: () => 'А если взять дешевле и почти без запаса, чем это рискованно на практике? И для редких отключений бензиновый или дизельный выгоднее?'
  },
  {
    phase: 'second_need_plate',
    makeText: () => 'Еще нужна виброплита для дорожек на участке. Будет плитка, песок, иногда немного щебня, площадь около 30-40 квадратов. Таскать буду сам, слишком тяжелую не хочу.'
  },
  {
    phase: 'plate_technical_selection',
    makeText: () => 'По виброплите объясните просто: что для моей задачи важнее - вес, глубина уплотнения или размер подошвы? И какие варианты можно смотреть?'
  },
  {
    phase: 'generator_operation_and_service',
    makeText: () => 'Вернусь к генератору: нужен ли АВР или автозапуск, если отключения редкие? И что обслуживать, чтобы бензиновый нормально заводился после простоя?'
  },
  {
    phase: 'commercial_without_exact_bundle_total',
    makeText: () => 'Доставка есть? Скидки бывают? И можно понять порядок суммы, если генератор выбираем предварительно, а по виброплите есть несколько вариантов?'
  },
  {
    phase: 'contact_refusal_final_summary',
    makeText: () => 'Пока без звонка. Скажите коротко, что сейчас разумно смотреть по генератору и виброплите, и какие данные еще надо уточнить перед точным выбором.'
  }
];

const criticalTextPatterns = [
  /network error/i,
  /AI FALLBACK/i,
  /Connection error/i,
  /ответ не успел|не успел сформироваться/i,
  /server finished without a done payload/i,
  /\bundefined\b|\bnull\b/i
];

function latestAssistant(messages) {
  return [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
}

async function collectMessages(page) {
  return page.locator('.message').evaluateAll((nodes) => nodes.map((node) => ({
    role: node.classList.contains('assistant') ? 'assistant' : node.classList.contains('user') ? 'user' : 'system',
    text: node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })));
}

async function waitInputEnabled(input, timeoutMs = 210_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await input.isEnabled().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Chat input did not become enabled before timeout.');
}

async function waitAssistantTurn(page, previousAssistantCount, input, timeoutMs = 210_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const assistantCount = await page.locator('.message.assistant').count().catch(() => 0);
    const enabled = await input.isEnabled().catch(() => false);
    if (assistantCount > previousAssistantCount && enabled) {
      await page.waitForTimeout(800);
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Assistant answer did not finish before timeout.');
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

function assertNoCriticalText(text, phase) {
  for (const pattern of criticalTextPatterns) {
    if (pattern.test(text)) throw new Error(`Critical text ${pattern} in ${phase}: ${text}`);
  }
}

function assertNoFallbackUi(pageText, phase) {
  if (/AI fallback|AI FALLBACK|need:\s|planner:\s|answer:\s/i.test(pageText)) {
    throw new Error(`Visible fallback diagnostics in ${phase}: ${pageText}`);
  }
}

function hasGeneratorCardText(text) {
  return /(?:Открыть карточку|Показано\s+\d+|Показать еще|Карточки)/iu.test(text) &&
    /(?:генератор|бензогенератор|электростанц)/iu.test(text);
}

function assertPhase(phase, answer, pageText) {
  const combined = `${answer}\n${pageText}`;
  assertNoCriticalText(combined, phase);
  assertNoFallbackUi(pageText, phase);

  if (phase === 'load_details_with_unknown_pump_power') {
    if (!/(насос).{0,120}(мощност|модель|шильдик|тип)|(?:мощност|модель|шильдик|тип).{0,120}(насос)/iu.test(answer)) {
      throw new Error(`The answer did not keep pump uncertainty visible: ${answer}`);
    }
  }

  if (phase === 'preliminary_generator_selection') {
    if (!hasGeneratorCardText(combined)) {
      throw new Error(`Preliminary generator selection did not show generator cards: ${combined}`);
    }
    if (!/(предвар|точн|мощност|насос|шильдик|модель)/iu.test(answer)) {
      throw new Error(`Generator card answer did not state the pump limitation: ${answer}`);
    }
  }

  if (phase === 'running_load_after_start') {
    if (!/(после запуска|когда.*работа|рабоч).{0,180}(остан|запас|свобод)|болгарк|1[,.]2/iu.test(answer)) {
      throw new Error(`Running-load answer did not reason about remaining power: ${answer}`);
    }
  }

  if (phase === 'reserve_and_fuel_comparison') {
    if (!/бензин/iu.test(answer) || !/дизел/iu.test(answer) || !/(запас|пуск|просад|перегруз|напряж)/iu.test(answer)) {
      throw new Error(`Comparison did not cover fuel and reserve risk: ${answer}`);
    }
  }

  if (phase === 'plate_technical_selection') {
    if (!/виброплит/iu.test(answer) || !/(вес|глубин|подошв|плитк|песок|щеб)/iu.test(answer)) {
      throw new Error(`Plate technical selection did not answer the technical criteria: ${answer}`);
    }
  }

  if (phase === 'generator_operation_and_service') {
    if (!/(АВР|автозапуск|авто)/iu.test(answer) || !/(масл|топлив|запуск|простой|обслуж)/iu.test(answer)) {
      throw new Error(`Generator operation/service answer missed AVR or maintenance: ${answer}`);
    }
  }

  if (phase === 'commercial_without_exact_bundle_total') {
    if (!/(доставк|логист|услов|специалист|менеджер)/iu.test(answer)) {
      throw new Error(`Commercial answer did not separate delivery/discount conditions: ${answer}`);
    }
    if (/(итоговая|общая|комплект).{0,80}\d[\d\s]*(?:₽|руб)/iu.test(answer) && !/(предвар|точн|выбран|не определ)/iu.test(answer)) {
      throw new Error(`Commercial answer gave an overconfident bundle total: ${answer}`);
    }
  }

  if (phase === 'contact_refusal_final_summary') {
    if (/остав(ь|ьте).{0,80}(телефон|номер|контакт)|напишите.{0,80}(телефон|номер)/iu.test(answer)) {
      throw new Error(`Lead pressure after contact refusal: ${answer}`);
    }
    if (!/генератор/iu.test(answer) || !/виброплит/iu.test(answer)) {
      throw new Error(`Final answer lost generator or plate need: ${answer}`);
    }
  }
}

function fallbackUsed(metadata) {
  const diagnostics = metadata?.aiDiagnostics ?? {};
  return Boolean(
    diagnostics.needExtractionFallback?.used ||
    diagnostics.turnPlanningFallback?.used ||
    diagnostics.answerGenerationFallback?.used ||
    metadata?.answerGenerationFallback?.used
  );
}

async function queryDb(sessionId) {
  const connectionString = process.env.DATABASE_URL || 'postgres://chat_ai:chat_ai@localhost:5432/chat_ai';
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const messages = await client.query(
      `SELECT id, role, content, metadata, created_at
       FROM messages
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );
    const turns = await client.query(
      `SELECT id, status, stage, error_code, error_message
       FROM conversation_turns
       WHERE session_id = $1
       ORDER BY created_at ASC`,
      [sessionId]
    );
    return { messages: messages.rows, turns: turns.rows };
  } finally {
    await client.end();
  }
}

function assertDbDiagnostics(db, expectedAssistantTurns) {
  const assistantMessages = db.messages.filter((message) => message.role === 'assistant' && message.metadata?.turnId);
  if (assistantMessages.length !== expectedAssistantTurns) {
    throw new Error(`Expected ${expectedAssistantTurns} assistant turn messages, got ${assistantMessages.length}.`);
  }
  for (const message of assistantMessages) {
    if (fallbackUsed(message.metadata)) {
      throw new Error(`AI fallback used in assistant message ${message.id}: ${JSON.stringify(message.metadata.aiDiagnostics ?? message.metadata.answerGenerationFallback)}`);
    }
  }
  const badTurns = db.turns.filter((turn) => !['completed', 'recovered'].includes(turn.status));
  if (badTurns.length) {
    throw new Error(`Non-completed turns found: ${JSON.stringify(badTurns)}`);
  }
}

async function main() {
  await fs.mkdir('local-live-tests', { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: await resolveBrowserExecutable()
  });
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const steps = [];

  try {
    await page.goto(widgetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByRole('button').filter({ hasText: /чат|консультант|задать|написать/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
    const input = page.locator('textarea, input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: 60_000 });

    for (const turn of phases) {
      const beforeAssistantCount = await page.locator('.message.assistant').count().catch(() => 0);
      await waitInputEnabled(input);
      const userText = turn.makeText(latestAssistant(await collectMessages(page)), await page.locator('body').innerText().catch(() => ''));
      await input.fill(userText);
      await input.press('Enter');
      await waitAssistantTurn(page, beforeAssistantCount, input);

      const messages = await collectMessages(page);
      const answer = latestAssistant(messages);
      const pageText = await page.locator('body').innerText().catch(() => '');
      if (!answer) throw new Error(`Empty assistant answer after ${turn.phase}`);
      assertPhase(turn.phase, answer, pageText);
      steps.push({ phase: turn.phase, user: userText, assistant: answer });
      console.log(`PASS turn ${steps.length}: ${turn.phase}`);
    }

    const sessionId = await page.evaluate(() => sessionStorage.getItem('bakaut_session_id'));
    if (!sessionId) throw new Error('Could not read bakaut_session_id from sessionStorage.');
    const db = await queryDb(sessionId);
    assertDbDiagnostics(db, phases.length);

    await fs.writeFile(protocolPath, [
      '# Local Full Agent-Cycle LLM Live Test',
      '',
      `URL: ${widgetUrl}`,
      `Session: ${sessionId}`,
      `Date: ${new Date().toISOString()}`,
      '',
      ...steps.flatMap((step, index) => [
        `## Turn ${index + 1}: ${step.phase}`,
        '',
        `**User:** ${step.user}`,
        '',
        `**Assistant:** ${step.assistant}`,
        ''
      ]),
      '## Metadata Audit',
      '',
      `- Assistant turn messages checked in DB: ${phases.length}`,
      '- PASS: needExtractionFallback.used=false for every assistant turn.',
      '- PASS: turnPlanningFallback.used=false for every assistant turn.',
      '- PASS: answerGenerationFallback.used=false for every assistant turn.',
      '- PASS: all conversation_turns completed.',
      '- PASS: UI did not show AI fallback diagnostics, network error, empty answer, or timeout text.',
      '- PASS: generator and plate needs were both retained through the final summary.'
    ].join('\n'), 'utf8');

    console.log(`PASS local full agent-cycle LLM live test. Protocol: ${protocolPath}`);
  } catch (error) {
    await fs.writeFile(failurePath, JSON.stringify({ error: String(error), steps }, null, 2), 'utf8');
    throw error;
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main();
