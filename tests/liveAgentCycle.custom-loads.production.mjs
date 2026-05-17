import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { assertProductionRemediationMarker } from './remediationProductionMarker.mjs';
import { requireProductionLiveApproval } from './productionLiveGate.mjs';
import { requireProductionOpenAiRuntimeReady } from './productionOpenAiRuntimePreflight.mjs';

dotenv.config();
requireProductionLiveApproval({
  scriptName: 'liveAgentCycle.custom-loads.production focused buyer audit',
  adaptiveBuyer: true
});

const productionApiBase = 'https://chat-ai-production-3057.up.railway.app';
const started = new Date().toISOString();
const safeStamp = started.replace(/[:.]/g, '-');
const protocolPath = path.join('local-live-tests', `${started.slice(0, 10)}-production-custom-loads-${safeStamp}.production.md`);
const detailPath = path.join('local-live-tests', `${started.slice(0, 10)}-production-custom-loads-${safeStamp}.json`);
const failurePath = path.join('local-live-tests', 'production-custom-loads-failure.json');
const liveRequiredRemainingTokens = Number(process.env.PRODUCTION_LIVE_REQUIRED_REMAINING_TOKENS ?? 300_000);

const turns = [
  {
    phase: 'changed_loads_generator_calculation',
    user: 'Здравствуйте. Подбираю генератор не для дома, а для небольшого гаража-магазина при отключениях. Потребители такие: морозильный ларь около 500 Вт, циркуляционный насос отопления 100 Вт, автоматика ворот 600 Вт, камеры с роутером 80 Вт, касса с ноутбуком 200 Вт и светодиодный свет 250 Вт. Скважинного насоса и электроинструмента не будет. Какую мощность смотреть без лишнего запаса?',
    expected: 'Должен пересчитать по новому набору потребителей, не тащить старые 6-8 кВт и не смешивать со скважинным насосом.'
  },
  {
    phase: 'explicit_generator_13kw',
    user: 'Теперь отдельно другой запрос: нужен генератор примерно 13 кВт. Что есть в каталоге и какие варианты смотреть?',
    expected: 'Должен переключиться на явный запрос 13 кВт и показать/обсудить генераторы около 13 кВт, а не старый расчет малой нагрузки.'
  },
  {
    phase: 'vibroplate_1000kg',
    user: 'Еще вопрос по уплотнению: нужна виброплита примерно 1000 кг. Есть такие или что вместо нее смотреть?',
    expected: 'Должен переключиться на виброплиту, не показывать генераторы; если 1000 кг нет, честно объяснить и предложить близкий тип техники/уточнение.'
  },
  {
    phase: 'gas_cutoff_saw_350mm',
    user: 'И еще нужен бензиновый резчик под диск 350 мм. Покажите, что есть.',
    expected: 'Должен переключиться на бензорез/швонарезчик/отрезчик с диском 350 мм и не тащить карточки генераторов или виброплит.'
  }
];

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/КопироватьХорошоПлохо/g, '')
    .trim();
}

function latestAssistant(messages) {
  return [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
}

async function collectMessages(frame) {
  return frame.locator('.message').evaluateAll((nodes) => nodes.map((node) => ({
    role: node.classList.contains('assistant') ? 'assistant' : node.classList.contains('user') ? 'user' : 'system',
    text: node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })));
}

async function collectNewCards(frame, previousCount) {
  return frame.locator('.product-card').evaluateAll((nodes, skip) =>
    nodes.slice(Number(skip) || 0).map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
    previousCount
  ).catch(() => []);
}

async function waitInputEnabled(input, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await input.isEnabled().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Chat input did not become enabled before timeout.');
}

async function readWidgetSessionId(page) {
  const chatFrame = page.frames().find((candidate) => /chat-ai-production|railway|\/widget/iu.test(candidate.url()));
  if (!chatFrame) return null;
  return chatFrame.evaluate(() => sessionStorage.getItem('bakaut_session_id')).catch(() => null);
}

async function fetchProductionConversation(sessionId) {
  const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
  if (!token) return null;
  const response = await fetch(`${productionApiBase}/api/admin/conversations/${sessionId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Production admin detail failed: ${response.status}`);
  return response.json();
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
      // Try next browser.
    }
  }
  return undefined;
}

function metadataOf(message) {
  if (!message?.metadata) return {};
  if (typeof message.metadata === 'string') {
    try {
      return JSON.parse(message.metadata);
    } catch {
      return {};
    }
  }
  return message.metadata;
}

function cardNames(cards) {
  return cards.map((card) => cleanText(card).replace(/Открыть карточку.*$/iu, '').trim()).filter(Boolean);
}

function buyerAudit(step) {
  const issues = [];
  const answer = cleanText(step.assistant);
  const cards = cardNames(step.newCards);
  const cardText = cards.join('\n');
  const combined = `${answer}\n${cardText}`;

  if (!answer) issues.push('пустой ответ');
  if (/Сейчас не смог надежно сформировать ответ|Ответ не успел сформироваться|undefined|null|network error/iu.test(answer)) {
    issues.push('технический fallback в видимом ответе');
  }

  if (step.phase === 'changed_loads_generator_calculation') {
    if (!/(кВт|мощност|запас|пуск|морозиль|ворот|насос отоплен|циркуляц)/iu.test(answer)) {
      issues.push('не объяснил расчет мощности по новому набору потребителей');
    }
    if (/(6\s*[-–]\s*8|7\s*[-–]\s*8|8\s*кВт)/iu.test(answer)) {
      issues.push('снова дал завышенный бытовой диапазон 6-8/8 кВт на малые нагрузки');
    }
    if (/скважинн/iu.test(answer)) {
      issues.push('протащил старый скважинный насос, которого в новом запросе нет');
    }
    if (/виброплит|резчик|бензорез/iu.test(cardText)) {
      issues.push('карточки не генераторные на генераторном расчете');
    }
  }

  if (step.phase === 'explicit_generator_13kw') {
    if (!/генератор/iu.test(combined) || !/(13|12|14|15)\s*кВт/iu.test(combined)) {
      issues.push('не удержал явный запрос генератора около 13 кВт');
    }
    if (/(3[,.]?\d?\s*кВт|4[,.]?\d?\s*кВт|морозиль|ворот)/iu.test(answer) && !/(13|12|14|15)\s*кВт/iu.test(answer)) {
      issues.push('ответ застрял в предыдущем малом расчете');
    }
    if (/виброплит|резчик|бензорез/iu.test(cardText)) {
      issues.push('карточки не генераторные на запросе 13 кВт');
    }
  }

  if (step.phase === 'vibroplate_1000kg') {
    if (!/виброплит|виброкат|каток|трамбов|уплотн|1000|тонн/iu.test(answer)) {
      issues.push('не переключился на тяжелую виброплиту/уплотнение 1000 кг');
    }
    if (/генератор|резчик|бензорез/iu.test(cardText)) {
      issues.push('карточки не соответствуют виброплите/уплотнению');
    }
  }

  if (step.phase === 'gas_cutoff_saw_350mm') {
    if (!/(резчик|бензорез|отрезчик|швонарезчик|диск|350)/iu.test(combined)) {
      issues.push('не переключился на бензиновый резчик 350 мм');
    }
    if (/генератор|виброплит/iu.test(cardText)) {
      issues.push('карточки не соответствуют резчику 350 мм');
    }
  }

  return issues;
}

function codeAudit(step, assistantMessage, turn) {
  const issues = [];
  const metadata = metadataOf(assistantMessage);
  const contract = metadata.turnContract ?? {};
  const cards = metadata.productCards ?? [];
  const warnings = [
    ...(metadata.validatorWarnings ?? []),
    ...(contract.validatorWarnings ?? []),
    ...((metadata.postAnswerVerification?.issues ?? []).map((issue) => issue.code))
  ];

  if (!assistantMessage) issues.push('нет assistant message в admin metadata');
  if (turn?.status && !['completed', 'recovered'].includes(turn.status)) issues.push(`turn status=${turn.status}`);
  if (turn?.errorCode) issues.push(`turn error=${turn.errorCode}: ${turn.errorMessage ?? ''}`);
  if (metadata.recovered || metadata.answerGenerationFallback?.used) issues.push('fallback/recovery в metadata');
  if (!contract.taskType || !contract.catalogAction || !contract.productCardsPolicy) issues.push('нет полного turnContract');

  if (step.phase === 'explicit_generator_13kw' && cards.some((card) => /виброплит|резчик|бензорез/iu.test(card.name ?? ''))) {
    issues.push('metadata.productCards содержит не генераторы на запросе 13 кВт');
  }
  if (step.phase === 'vibroplate_1000kg' && cards.some((card) => /генератор|резчик|бензорез/iu.test(card.name ?? ''))) {
    issues.push('metadata.productCards содержит не виброплиту/уплотнение');
  }
  if (step.phase === 'gas_cutoff_saw_350mm' && cards.some((card) => /генератор|виброплит/iu.test(card.name ?? ''))) {
    issues.push('metadata.productCards содержит не резчик');
  }

  return {
    issues,
    contract: {
      taskType: contract.taskType ?? null,
      catalogAction: contract.catalogAction ?? null,
      productCardsPolicy: contract.productCardsPolicy ?? null,
      cardsRole: contract.cardsRole ?? null,
      answerTask: contract.answerTask ?? null,
      currentFocus: contract.currentFocus ?? null
    },
    warnings,
    productCards: cards.map((card) => card.name).filter(Boolean)
  };
}

function mdList(items, empty = '- нет') {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : empty;
}

async function main() {
  await fs.mkdir('local-live-tests', { recursive: true });
  const steps = [];
  let sessionId = null;
  let browser = null;

  try {
    await assertProductionRemediationMarker(productionApiBase);
    await requireProductionOpenAiRuntimeReady({
      productionApiBase,
      requiredRemainingTokens: liveRequiredRemainingTokens
    });

    browser = await chromium.launch({ headless: true, executablePath: await resolveBrowserExecutable() });
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    await page.goto('https://bakautprof.ru/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const iframeElement = page.locator('iframe[src*="chat-ai-production"], iframe[src*="railway"], iframe[src*="/widget"]').first();
    await iframeElement.waitFor({ state: 'attached', timeout: 60_000 });
    const frame = await iframeElement.contentFrame();
    if (!frame) throw new Error('Chat iframe frame was not available.');

    await frame.getByRole('button').filter({ hasText: /чат|консультант|задать|написать/i }).first().click({ timeout: 20_000 }).catch(() => undefined);
    const input = frame.locator('textarea, input[type="text"]').first();
    await input.waitFor({ state: 'visible', timeout: 60_000 });

    let previousProductCardCount = await frame.locator('.product-card').count().catch(() => 0);
    for (const turn of turns) {
      await waitInputEnabled(input);
      await input.fill(turn.user);
      await input.press('Enter');
      await waitInputEnabled(input);
      await page.waitForTimeout(1200);

      const messages = await collectMessages(frame);
      const assistant = cleanText(latestAssistant(messages));
      const newCards = await collectNewCards(frame, previousProductCardCount);
      previousProductCardCount = await frame.locator('.product-card').count().catch(() => previousProductCardCount);
      const buyerIssues = buyerAudit({ ...turn, assistant, newCards });
      steps.push({ ...turn, assistant, newCards: cardNames(newCards), buyerIssues });
      console.log(`${turn.phase}: ${buyerIssues.length ? `BUYER_ISSUES ${buyerIssues.length}` : 'buyer ok'}; cards=${newCards.length}`);
    }

    sessionId = await readWidgetSessionId(page);
    const detail = sessionId ? await fetchProductionConversation(sessionId) : null;
    if (detail) {
      await fs.writeFile(detailPath, JSON.stringify({ turns, productionConversation: detail }, null, 2), 'utf8');
    }

    const assistantMessages = detail?.messages?.filter((message) => message.role === 'assistant') ?? [];
    const adminTurns = detail?.turns ?? [];
    const auditedSteps = steps.map((step, index) => ({
      ...step,
      code: codeAudit(step, assistantMessages[index], adminTurns[index])
    }));
    const buyerIssueCount = auditedSteps.reduce((sum, step) => sum + step.buyerIssues.length, 0);
    const codeIssueCount = auditedSteps.reduce((sum, step) => sum + step.code.issues.length, 0);

    await fs.writeFile(protocolPath, [
      '# Production custom loads live audit',
      '',
      `URL: https://bakautprof.ru/`,
      `Date: ${new Date().toISOString()}`,
      `Session: ${sessionId ?? 'unknown'}`,
      `Admin metadata: ${detail ? detailPath : 'not available'}`,
      `Status: ${buyerIssueCount === 0 && codeIssueCount === 0 ? 'PASS' : 'FAIL'}`,
      '',
      '## Turns',
      '',
      ...auditedSteps.flatMap((step, index) => [
        `### ${index + 1}. ${step.phase}`,
        '',
        `Buyer: ${step.user}`,
        '',
        `Expected: ${step.expected}`,
        '',
        `Assistant: ${step.assistant}`,
        '',
        'New cards:',
        mdList(step.newCards),
        '',
        'Buyer-visible issues:',
        mdList(step.buyerIssues),
        '',
        'Code/admin issues:',
        mdList(step.code.issues),
        '',
        `Contract: ${JSON.stringify(step.code.contract)}`,
        '',
        'Metadata product cards:',
        mdList(step.code.productCards),
        ''
      ]),
      '## Summary',
      '',
      `Buyer-visible issue count: ${buyerIssueCount}`,
      `Code/admin issue count: ${codeIssueCount}`
    ].join('\n'), 'utf8');

    if (buyerIssueCount || codeIssueCount) {
      console.error(JSON.stringify({ ok: false, protocolPath, detailPath, buyerIssueCount, codeIssueCount }, null, 2));
      process.exit(1);
    }

    console.log(JSON.stringify({ ok: true, protocolPath, detailPath, sessionId }, null, 2));
  } catch (error) {
    await fs.writeFile(failurePath, JSON.stringify({
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      steps,
      sessionId
    }, null, 2), 'utf8');
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

await main();
