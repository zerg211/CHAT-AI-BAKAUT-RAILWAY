import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { assertProductionRemediationMarker } from './remediationProductionMarker.mjs';
import {
  assertNonRepeatingProductionDialogue,
  dialoguePolicyMarkdown,
  loadProductionLiveDialogue
} from './productionLiveDialoguePolicy.mjs';
import { requireProductionLiveApproval } from './productionLiveGate.mjs';

dotenv.config();
requireProductionLiveApproval({
  scriptName: 'liveAgentCycle.diverse.production final buyer audit',
  allowFixedReplay: true
});

const productionApiBase = 'https://chat-ai-production-3057.up.railway.app';
const started = new Date().toISOString();
const safeStamp = started.replace(/[:.]/g, '-');
const protocolPath = path.join('local-live-tests', `${started.slice(0, 10)}-production-diverse-buyer-audit-${safeStamp}.production.md`);
const detailPath = path.join('local-live-tests', `${started.slice(0, 10)}-production-diverse-buyer-audit-${safeStamp}.json`);
const failurePath = path.join('local-live-tests', 'production-diverse-buyer-audit-failure.json');

const bundledTurns = [
  {
    phase: 'household_unclear_generator',
    user: 'Добрый день. Я первый раз выбираю генератор. На дачу надо: холодильник, насос, свет и иногда чайник. Какой мощности смотреть, чтобы не купить лишнее?'
  },
  {
    phase: 'silly_fridge_inverter_question',
    user: 'А холодильник от генератора не сгорит? Мне обязательно инверторный брать или обычный тоже нормальный?'
  },
  {
    phase: 'cheap_catalog_4_6kw_220',
    user: 'Покажите тогда что есть подешевле из генераторов 4-6 кВт на 220 В. Бренд не важен, главное без переплаты.'
  },
  {
    phase: 'exact_model_typo_bison',
    user: 'А Bison 3250 есть? Может я модель криво написал.'
  },
  {
    phase: 'commercial_diesel_15_20kw_380',
    user: 'Теперь другая задача: для бригады нужен дизельный генератор 15-20 кВт, 380 В, чтобы тянуть инструмент и бетономешалку. Что в каталоге есть?'
  },
  {
    phase: 'engine_comparison_no_exact_models',
    user: 'Если для такой ДГУ сравнить в целом Baudouin и Doosan, что надежнее? Конкретных моделей пока нет.'
  },
  {
    phase: 'switch_to_plate_80_90kg_home',
    user: 'Еще нужна виброплита для дорожек и площадки под машину. Я не профи, хочу не тяжелее примерно 80-90 кг, чтобы самому грузить. Что посоветуете?'
  },
  {
    phase: 'plate_weight_100_120_question',
    user: 'А если взять 100-120 кг, сильно лучше будет? У меня песок, немного щебня и сверху плитка.'
  },
  {
    phase: 'plate_catalog_90_120kg_cheap',
    user: 'Покажите из каталога виброплиты 90-120 кг, желательно не самые дорогие.'
  },
  {
    phase: 'plate_mat_accessory_question',
    user: 'Для плитки к такой плите нужен коврик или можно без него?'
  },
  {
    phase: 'delivery_discount_no_contact',
    user: 'Доставка до Ейска и скидка есть, если брать генератор и виброплиту? Номер пока не оставляю, просто хочу понять порядок.'
  },
  {
    phase: 'final_no_call_summary',
    user: 'Пока без звонка. Коротко подведите итог: что смотреть по генератору, что по виброплите и что мне надо уточнить перед точным выбором.'
  }
];

const productionDialogue = await loadProductionLiveDialogue({
  defaultTurns: bundledTurns,
  defaultScenarioName: 'diverse-buyer-audit-generator-plate-v1'
});
const turns = productionDialogue.turns;
const dialoguePolicy = await assertNonRepeatingProductionDialogue({
  scriptName: 'liveAgentCycle.diverse.production final buyer audit',
  scenarioName: productionDialogue.scenarioName,
  turns,
  artifactDir: 'local-live-tests',
  excludePaths: [protocolPath, detailPath, failurePath]
});

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/КопироватьХорошоПлохо/g, '')
    .replace(/КарточкиПодходящие варианты\d+\s*шт\./g, '')
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

function hasDuplicateLongSentence(text) {
  const sentences = cleanText(text)
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 60);
  const seen = new Set();
  for (const sentence of sentences) {
    const key = sentence.toLowerCase();
    if (seen.has(key)) return sentence;
    seen.add(key);
  }
  return '';
}

function cardNames(cards) {
  return cards.map((card) => cleanText(card).replace(/Открыть карточку.*$/iu, '').trim()).filter(Boolean);
}

function buyerAudit(step) {
  const issues = [];
  const answer = cleanText(step.assistant);
  const cards = cardNames(step.newCards);
  const combinedCards = cards.join('\n');
  const combined = `${answer}\n${combinedCards}`;
  const duplicate = hasDuplicateLongSentence(answer);

  if (!answer) issues.push('пустой ответ');
  if (duplicate) issues.push(`повтор длинного предложения: ${duplicate}`);
  if (/undefined|null|network error|server finished without a done payload/iu.test(answer)) issues.push('технический текст в ответе');
  if (/менеджер.{0,80}(подтверд|провер|уточн|посчит)|должен.{0,80}менеджер|передам.{0,80}менеджер|через\s+менеджер|оформ\w*.{0,80}менеджер/iu.test(answer)) {
    issues.push('говорит про менеджера как про третье лицо, а должен отвечать от лица AI-менеджера');
  }

  if (step.phase === 'household_unclear_generator') {
    if (!/генератор/iu.test(answer) || !/(кВт|мощност|запас|насос|пуск)/iu.test(answer)) {
      issues.push('не дал прямой первичный ориентир по мощности/пусковым нагрузкам');
    }
  }

  if (step.phase === 'silly_fridge_inverter_question') {
    if (!/(холодильник|инвертор|обычн|напряж|стабилиз|качество)/iu.test(answer)) {
      issues.push('не ответил прямо на бытовой вопрос про холодильник и инвертор');
    }
  }

  if (step.phase === 'cheap_catalog_4_6kw_220') {
    if (!cards.length) issues.push('на прямой запрос по каталогу 4-6 кВт не показал карточки');
    if (/виброплит|дизельн/iu.test(combinedCards)) issues.push('карточки не соответствуют бензо/бытовому генераторному подбору');
    if (!/(4|5|6)[,.]?\d*\s*кВт|4-6\s*кВт|генератор/iu.test(combined)) issues.push('ответ/карточки не держат диапазон 4-6 кВт');
  }

  if (step.phase === 'exact_model_typo_bison') {
    if (!/BS3250i|BISON/iu.test(combined)) issues.push('не предложил близкую модель BISON BS3250i');
    if (!cards.some((card) => /BS3250i|BISON/iu.test(card))) issues.push('не показал карточку близкой модели BISON');
    if (!/(имели в виду|это он|похож|ближайш)/iu.test(answer)) issues.push('не уточнил, эту ли близкую модель имел в виду покупатель');
  }

  if (step.phase === 'commercial_diesel_15_20kw_380') {
    if (!/дизель|380|15|20|кВт|ДГУ/iu.test(answer)) issues.push('не удержал коммерческую дизельную потребность 15-20 кВт 380 В');
    if (!cards.length) issues.push('на прямой запрос по каталогу дизельных генераторов 15-20 кВт не показал карточки');
    if (/расчетный минимум[^.]{0,80}4[,.]?5\s*кВт|пусковая нагрузка[^.]{0,80}4[,.]?1\s*кВт/iu.test(answer)) {
      issues.push('протащил старый бытовой расчет мощности в новую коммерческую потребность');
    }
    if (cards.length && /бензинов/iu.test(combinedCards) && !/дизель/iu.test(combinedCards)) {
      issues.push('показал бензиновые карточки на дизельный запрос');
    }
  }

  if (step.phase === 'engine_comparison_no_exact_models') {
    if (!/Baudouin|Doosan|бадуин|дусан/iu.test(answer)) issues.push('не ответил на сравнение Baudouin vs Doosan');
    if (!/(в целом|обычно|ресурс|сервис|запчаст|нагруз|ДГУ|промышлен)/iu.test(answer)) {
      issues.push('сравнение слишком пустое или только просит модели');
    }
    if (cards.length) issues.push('на техническое сравнение двигателей появились новые карточки');
  }

  if (step.phase === 'switch_to_plate_80_90kg_home') {
    if (!/виброплит|80|90|кг|плитк|песок|щеб/iu.test(answer)) issues.push('не переключился на потребность по виброплите 80-90 кг');
    if (/генератор/iu.test(combinedCards)) issues.push('после смены потребности показал генераторы вместо виброплит');
  }

  if (step.phase === 'plate_weight_100_120_question') {
    if (!/100|120|кг|вес|песок|щеб|плитк|уплотн/iu.test(answer)) issues.push('не ответил по смыслу на вопрос о весе 100-120 кг');
    if (/генератор/iu.test(combinedCards)) issues.push('на технический вопрос по виброплите протащил генераторы');
  }

  if (step.phase === 'plate_catalog_90_120kg_cheap') {
    if (!cards.length) issues.push('на прямой запрос по каталогу виброплит 90-120 кг не показал карточки');
    if (/генератор/iu.test(combinedCards)) issues.push('в карточках виброплит появились генераторы');
    if (cards.some((card) => /\b8[0-9]\s*кг\b/iu.test(card))) issues.push('в диапазон 90-120 кг попала карточка легче 90 кг');
    if (!/виброплит|90|100|120|кг|не сам|дешев/iu.test(combined)) issues.push('ответ/карточки не держат весовой диапазон и ценовой приоритет');
  }

  if (step.phase === 'plate_mat_accessory_question') {
    if (!/коврик|полиуретан|плитк|резин|без него/iu.test(answer)) issues.push('не ответил на вопрос про коврик для плитки');
  }

  if (step.phase === 'delivery_discount_no_contact') {
    if (!/доставк|скидк|Ейск|услов|свер|уточн|посчита/iu.test(answer)) issues.push('не ответил по доставке/скидке');
    if (/остав(ь|ьте|ить).{0,80}(телефон|номер|контакт)|напишите.{0,80}(телефон|номер)|как вас зовут/iu.test(answer)) {
      issues.push('давит на контакт, хотя покупатель явно отказался оставлять номер');
    }
  }

  if (step.phase === 'final_no_call_summary') {
    if (!/(генератор|ДГУ)/iu.test(answer) || !/виброплит/iu.test(answer)) issues.push('финальный итог потерял одну из двух потребностей');
    if (/остав(ь|ьте|ить).{0,80}(телефон|номер|контакт)|напишите.{0,80}(телефон|номер)/iu.test(answer)) {
      issues.push('в финальном no-call ответе снова просит контакт');
    }
  }

  return issues;
}

function codeAudit(step, assistantMessage) {
  const issues = [];
  const metadata = metadataOf(assistantMessage);
  const contract = metadata.turnContract ?? {};
  const warnings = [
    ...(metadata.validatorWarnings ?? []),
    ...(contract.validatorWarnings ?? []),
    ...(metadata.requirementLedger?.warnings ?? []),
    ...(metadata.executionContract?.warnings ?? []),
    ...(metadata.cardManifest?.warnings ?? []),
    ...(metadata.factClaimPlanner?.warnings ?? []),
    ...(metadata.factClaimAudit?.warnings ?? []),
    ...(metadata.leadStateMachine?.warnings ?? []),
    ...((metadata.postAnswerVerification?.issues ?? []).map((issue) => issue.code))
  ];
  const productCards = metadata.productCards ?? [];
  const diagnostics = metadata.aiDiagnostics ?? {};
  const fallbackStage = Object.entries(diagnostics).find(([, diagnostic]) => diagnostic?.used);

  if (metadata.recovered || metadata.answerGenerationFallback?.used || fallbackStage) {
    issues.push(`fallback/recovery: ${fallbackStage?.[0] ?? 'answerGenerationFallback/recovered'}`);
  }
  if (!contract.taskType || !contract.catalogAction || !contract.productCardsPolicy) {
    issues.push('нет полного turnContract');
  }
  if (warnings.includes('contract_source:legacy_text_fallback')) {
    issues.push('legacy_text_fallback contract');
  }
  if (!metadata.requirementLedger) issues.push('нет requirementLedger');
  if (!metadata.executionContract) issues.push('нет executionContract');
  if (productCards.length && !metadata.cardManifest) issues.push('нет cardManifest для карточек');
  if (!metadata.factClaimPlanner) issues.push('нет factClaimPlanner');
  if (!metadata.leadStateMachine) issues.push('нет leadStateMachine');
  if (!metadata.factClaimAudit) issues.push('missing factClaimAudit');
  if (!metadata.postAnswerVerification) issues.push('missing postAnswerVerification');
  if (metadata.postAnswerVerification?.status === 'error') {
    issues.push(`post-answer verification failed: ${JSON.stringify(metadata.postAnswerVerification.issues)}`);
  }
  const visibleCardViolation = warnings.find((warning) => String(warning).startsWith('visible_card_constraint_violation:'));
  if (visibleCardViolation) issues.push(`visible card hard-constraint violation: ${visibleCardViolation}`);

  if (step.phase === 'cheap_catalog_4_6kw_220' && contract.productCardsPolicy === 'none') {
    issues.push('productCardsPolicy=none на прямой каталоговый запрос генераторов');
  }
  if (step.phase === 'exact_model_typo_bison') {
    if (contract.productCardsPolicy === 'none') issues.push('productCardsPolicy=none на exact lookup с близкой моделью');
    if (!productCards.some((card) => /BS3250i|BISON/iu.test(card.name ?? ''))) issues.push('metadata.productCards не содержит BISON BS3250i');
  }
  if (step.phase === 'plate_catalog_90_120kg_cheap' && contract.productCardsPolicy === 'none') {
    issues.push('productCardsPolicy=none на прямой каталоговый запрос виброплит');
  }
  if (/plate|вибро/iu.test(step.phase) && productCards.some((card) => /генератор/iu.test(card.name ?? ''))) {
    issues.push('metadata.productCards содержит генератор на виброплитном ходе');
  }
  if (/generator|bison|diesel|kw/iu.test(step.phase) && productCards.some((card) => /виброплит/iu.test(card.name ?? ''))) {
    issues.push('metadata.productCards содержит виброплиту на генераторном ходе');
  }

  return {
    issues,
    contract: {
      taskType: contract.taskType ?? null,
      catalogAction: contract.catalogAction ?? null,
      productCardsPolicy: contract.productCardsPolicy ?? null,
      cardsRole: contract.cardsRole ?? null,
      answerTask: contract.answerTask ?? null,
      leadAllowed: contract.leadAllowed ?? null
    },
    warnings,
    productCards: productCards.map((card) => card.name).filter(Boolean)
  };
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

function mdList(items, empty = '- нет') {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : empty;
}

async function main() {
  await fs.mkdir('local-live-tests', { recursive: true });
  await assertProductionRemediationMarker(productionApiBase);
  const browser = await chromium.launch({ headless: true, executablePath: await resolveBrowserExecutable() });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const steps = [];
  let sessionId = null;

  try {
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
      await fs.writeFile(detailPath, JSON.stringify({
        productionLiveDialogue: productionDialogue,
        productionLiveDialoguePolicy: dialoguePolicy,
        productionConversation: detail
      }, null, 2), 'utf8');
    }
    const assistantMessages = detail?.messages?.filter((message) => message.role === 'assistant') ?? [];
    const turns = detail?.turns ?? [];
    const metadataAvailable = assistantMessages.length >= steps.length;

    const auditedSteps = steps.map((step, index) => {
      const turnError = turns[index]?.errorCode
        ? `turn error: ${turns[index].errorCode}${turns[index].stage ? `/${turns[index].stage}` : ''}`
        : '';
      const code = metadataAvailable ? codeAudit(step, assistantMessages[index]) : {
        issues: ['admin metadata недоступна или количество ходов не совпало', turnError].filter(Boolean),
        contract: {},
        warnings: [],
        productCards: []
      };
      return { ...step, code };
    });

    const buyerIssueCount = auditedSteps.reduce((sum, step) => sum + step.buyerIssues.length, 0);
    const codeIssueCount = auditedSteps.reduce((sum, step) => sum + step.code.issues.length, 0);

    await fs.writeFile(protocolPath, [
      '# Production diverse buyer dialogue audit',
      '',
      `URL: https://bakautprof.ru/`,
      `Date: ${new Date().toISOString()}`,
      `Session: ${sessionId ?? 'unknown'}`,
      `Admin metadata: ${metadataAvailable ? detailPath : 'not available'}`,
      `Scenario source: ${productionDialogue.source}${productionDialogue.scenarioFile ? ` (${productionDialogue.scenarioFile})` : ''}`,
      ...dialoguePolicyMarkdown(dialoguePolicy),
      '',
      '## Scenario',
      '',
      'Новый живой диалог проведен через встроенный виджет на сайте bakautprof.ru. Реплики написаны как обычный покупатель, который впервые зашел на сайт: бытовой генератор, глупый техвопрос, дешевый каталоговый подбор, неточное название модели, коммерческий дизель, сравнение двигателей, виброплита по весу, аксессуар, доставка/скидка без контакта.',
      '',
      '## Summary',
      '',
      `- Buyer-view issues: ${buyerIssueCount}`,
      `- Code/metadata issues: ${codeIssueCount}`,
      '',
      ...auditedSteps.flatMap((step, index) => [
        `## Turn ${index + 1}: ${step.phase}`,
        '',
        `**User:** ${step.user}`,
        '',
        `**Assistant:** ${step.assistant}`,
        '',
        '**Visible new cards:**',
        '',
        mdList(step.newCards),
        '',
        '**Buyer-view audit:**',
        '',
        mdList(step.buyerIssues, '- OK'),
        '',
        '**Code/metadata audit:**',
        '',
        `- contract: \`${JSON.stringify(step.code.contract)}\``,
        `- metadata cards: ${step.code.productCards.length}`,
        mdList(step.code.productCards.map((name) => `card: ${name}`), '- cards: none'),
        mdList(step.code.warnings.map((warning) => `warning: ${warning}`), '- warnings: none'),
        mdList(step.code.issues, '- OK')
      ])
    ].join('\n'), 'utf8');

    console.log(`DONE diverse production audit. Buyer issues=${buyerIssueCount}; code issues=${codeIssueCount}; protocol=${protocolPath}`);
  } catch (error) {
    await fs.writeFile(failurePath, JSON.stringify({ error: String(error), productionDialogue, dialoguePolicy, sessionId, steps }, null, 2), 'utf8');
    throw error;
  } finally {
    await browser.close();
  }
}

main();
