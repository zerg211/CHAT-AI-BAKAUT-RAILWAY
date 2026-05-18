import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { assertProductionRemediationMarker } from './remediationProductionMarker.mjs';
import {
  assertNonRepeatingProductionDialogue,
  dialoguePolicyMarkdown
} from './productionLiveDialoguePolicy.mjs';
import { requireProductionLiveApproval } from './productionLiveGate.mjs';
import { requireProductionOpenAiRuntimeReady } from './productionOpenAiRuntimePreflight.mjs';
import {
  adaptiveBuyerPolicy,
  defaultAdaptiveBuyerGoal,
  evaluateAdaptiveGoalProgress,
  nextAdaptiveBuyerTurn
} from './adaptiveProductionBuyer.mjs';

dotenv.config();
requireProductionLiveApproval({
  scriptName: 'liveAgentCycle.diverse.production adaptive buyer audit',
  adaptiveBuyer: true
});

const productionApiBase = 'https://chat-ai-production-3057.up.railway.app';
const started = new Date().toISOString();
const safeStamp = started.replace(/[:.]/g, '-');
const protocolPath = path.join('local-live-tests', `${started.slice(0, 10)}-production-diverse-buyer-audit-${safeStamp}.production.md`);
const detailPath = path.join('local-live-tests', `${started.slice(0, 10)}-production-diverse-buyer-audit-${safeStamp}.json`);
const failurePath = path.join('local-live-tests', 'production-diverse-buyer-audit-failure.json');

const adaptiveBuyerGoal = defaultAdaptiveBuyerGoal;
const goalPolicy = adaptiveBuyerPolicy(adaptiveBuyerGoal);
let dialoguePolicy = null;
const liveRequiredRemainingTokens = Number(
  process.env.PRODUCTION_LIVE_REQUIRED_REMAINING_TOKENS ??
  Math.max(120_000, adaptiveBuyerGoal.maxTurns * 55_000)
);

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/КопироватьХорошоПлохо/g, '')
    .replace(/КарточкиПодходящие варианты\d+\s*шт\./g, '')
    .trim();
}

function hasInlineLeadContact(value) {
  const text = String(value ?? '');
  const digits = text.replace(/\D+/g, '');
  return digits.length >= 10 || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(text);
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

async function fetchProductionLeads(limit = 50) {
  const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
  if (!token) return null;
  const response = await fetch(`${productionApiBase}/api/admin/leads?limit=${limit}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Production admin leads failed: ${response.status}`);
  return response.json();
}

async function submitLeadForm(frame, leadForm) {
  const toggle = frame.getByRole('button', { name: /Оставить контакт/i }).first();
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.evaluate((element) => element.click());
  }
  await frame.locator('.lead-panel.expanded input').first().waitFor({ state: 'visible', timeout: 10_000 });
  await frame.getByLabel('Имя').fill(leadForm.name);
  await frame.getByLabel('Телефон').fill(leadForm.phone);
  if (leadForm.email) await frame.getByLabel('Email').fill(leadForm.email);
  await frame.getByLabel('Вопрос').fill(leadForm.question);
  await frame.getByRole('button', { name: /Отправить заявку/i }).click();
  await Promise.race([
    frame.locator('.form-note.ok').waitFor({ state: 'visible', timeout: 60_000 }),
    frame.locator('.form-note.bad').waitFor({ state: 'visible', timeout: 60_000 })
  ]);
  const panelText = cleanText(await frame.locator('.lead-panel').innerText());
  if (await frame.locator('.form-note.bad').isVisible().catch(() => false)) {
    throw new Error(`Lead form submit failed in widget: ${panelText}`);
  }
  return panelText;
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
  }

  if (step.phase === 'ready_to_submit_lead' || step.leadForm) {
    if (!/(заявк|контакт|телефон|свяж|уточн|налич|достав)/iu.test(answer)) {
      issues.push('не обработал готовность покупателя оставить заявку и телефон');
    }
    if (!step.leadSubmission?.submitted) issues.push('форма заявки не была отправлена в live-проверке');
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
  if (step.phase === 'ready_to_submit_lead' || step.leadForm) {
    const leadState = metadata.leadStateMachine;
    const leadViaForm = step.leadSubmission?.method === 'form';
    const leadViaChat = step.leadSubmission?.method === 'chat_contact' || hasInlineLeadContact(step.user);
    if (leadViaChat && leadState?.hasContactInTurn !== true) issues.push('leadStateMachine не распознал телефон в реплике покупателя');
    if (leadViaForm && leadState?.leadRequested !== true) issues.push('leadStateMachine не запросил контакт перед отправкой формы');
    if (metadata.executionContract?.leadPolicy === 'forbidden') issues.push('executionContract запретил lead на ходе, где покупатель сам оставил телефон');
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
    for (let turnIndex = 0; turnIndex < adaptiveBuyerGoal.maxTurns; turnIndex++) {
      const turn = await nextAdaptiveBuyerTurn({
        goal: adaptiveBuyerGoal,
        steps,
        turnIndex
      });
      if (turn.done) break;
      await waitInputEnabled(input);
      await input.fill(turn.user);
      await input.press('Enter');
      await waitInputEnabled(input);
      await page.waitForTimeout(1200);

      const messages = await collectMessages(frame);
      const assistant = cleanText(latestAssistant(messages));
      const newCards = await collectNewCards(frame, previousProductCardCount);
      previousProductCardCount = await frame.locator('.product-card').count().catch(() => previousProductCardCount);
      const inlineLeadContact = turn.leadForm && hasInlineLeadContact(turn.user);
      const leadSubmission = turn.leadForm
        ? inlineLeadContact
          ? {
              submitted: true,
              method: 'chat_contact',
              panelText: 'Контакт оставлен в реплике покупателя; лид проверяется через admin leads.'
            }
          : { submitted: true, method: 'form', panelText: await submitLeadForm(frame, turn.leadForm) }
        : null;
      const buyerIssues = buyerAudit({ ...turn, assistant, newCards, leadSubmission });
      steps.push({ ...turn, assistant, newCards: cardNames(newCards), buyerIssues, leadSubmission });
      console.log(`${turn.phase}: ${buyerIssues.length ? `BUYER_ISSUES ${buyerIssues.length}` : 'buyer ok'}; cards=${newCards.length}; buyer=${turn.source}`);
      if (leadSubmission?.submitted) break;
    }

    sessionId = await readWidgetSessionId(page);
    const generatedTurns = steps.map((step) => ({ phase: step.phase, user: step.user }));
    dialoguePolicy = await assertNonRepeatingProductionDialogue({
      scriptName: 'liveAgentCycle.diverse.production adaptive buyer audit',
      scenarioName: `${adaptiveBuyerGoal.scenarioName}-${safeStamp}`,
      turns: generatedTurns,
      artifactDir: 'local-live-tests',
      excludePaths: [
        protocolPath,
        detailPath,
        failurePath,
        path.join('local-live-tests', 'remediation-completion-audit.json'),
        path.join('local-live-tests', 'remediation-postdeploy.json')
      ]
    });
    const detail = sessionId ? await fetchProductionConversation(sessionId) : null;
    const leadData = sessionId ? await fetchProductionLeads() : null;
    const sessionLeads = leadData?.leads?.filter((lead) => lead.sessionId === sessionId) ?? [];
    if (detail) {
      await fs.writeFile(detailPath, JSON.stringify({
        adaptiveBuyerGoal,
        adaptiveBuyerGoalPolicy: goalPolicy,
        productionLiveDialoguePolicy: dialoguePolicy,
        productionConversation: detail,
        productionLeads: sessionLeads
      }, null, 2), 'utf8');
    }
    const assistantMessages = detail?.messages?.filter((message) => message.role === 'assistant') ?? [];
    const adminTurns = detail?.turns ?? [];
    const metadataAvailable = assistantMessages.length >= steps.length;

    const auditedSteps = steps.map((step, index) => {
      const turnError = adminTurns[index]?.errorCode
        ? `turn error: ${adminTurns[index].errorCode}${adminTurns[index].stage ? `/${adminTurns[index].stage}` : ''}`
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
    const expectedLeadNames = steps.map((step) => step.leadForm?.name).filter(Boolean);
    const leadAuditIssues = expectedLeadNames.length && leadData
      ? expectedLeadNames.filter((name) => !sessionLeads.some((lead) => lead.name === name)).map((name) => `заявка ${name} не найдена в admin leads по sessionId`)
      : [];
    const goalProgress = evaluateAdaptiveGoalProgress(auditedSteps, adaptiveBuyerGoal);

    await fs.writeFile(protocolPath, [
      '# Production adaptive buyer dialogue audit',
      '',
      `URL: https://bakautprof.ru/`,
      `Date: ${new Date().toISOString()}`,
      `Session: ${sessionId ?? 'unknown'}`,
      `Admin metadata: ${metadataAvailable ? detailPath : 'not available'}`,
      `Scenario source: adaptive buyer goal`,
      `Buyer persona: ${adaptiveBuyerGoal.persona}`,
      `Buyer objective: ${adaptiveBuyerGoal.objective}`,
      `Buyer goal signature: ${goalPolicy.dialogueSignature}`,
      ...dialoguePolicyMarkdown(dialoguePolicy),
      '',
      '## Scenario',
      '',
      'Новый живой диалог проведен через встроенный виджет на сайте bakautprof.ru. Покупателю задана цель, а каждая следующая реплика сгенерирована после фактического ответа ассистента и видимых карточек. Проверка не следует заранее заданному списку фраз.',
      '',
      '## Summary',
      '',
      `- Buyer-view issues: ${buyerIssueCount}`,
      `- Code/metadata issues: ${codeIssueCount}`,
      `- Buyer-goal issues: ${goalProgress.issues.length}`,
      `- Lead submissions: ${sessionLeads.length}${leadData ? '' : ' (admin leads unavailable)'}`,
      `- Lead audit issues: ${leadAuditIssues.length}`,
      '',
      ...goalProgress.issues.map((issue) => `- ${issue}`),
      goalProgress.issues.length ? '' : '- Buyer goal: OK',
      '',
      ...leadAuditIssues.map((issue) => `- ${issue}`),
      leadAuditIssues.length ? '' : '- Lead audit: OK',
      '',
      ...auditedSteps.flatMap((step, index) => [
        `## Turn ${index + 1}: ${step.phase}`,
        '',
        `**Buyer decision:** ${step.rationale ?? 'n/a'} (${step.source ?? 'unknown'})`,
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
        mdList(step.code.issues, '- OK'),
        step.leadSubmission ? `- lead submission (${step.leadSubmission.method ?? 'form'}): ${step.leadSubmission.panelText}` : '- lead submission: none'
      ])
    ].join('\n'), 'utf8');

    if (buyerIssueCount || codeIssueCount || leadAuditIssues.length || goalProgress.issues.length) {
      const error = new Error('production_diverse_live_audit_failed');
      error.details = {
        buyerIssueCount,
        codeIssueCount,
        leadAuditIssues,
        buyerGoalIssues: goalProgress.issues,
        protocolPath,
        sessionId
      };
      throw error;
    }

    console.log(`DONE diverse production audit. Buyer issues=${buyerIssueCount}; code issues=${codeIssueCount}; protocol=${protocolPath}`);
  } catch (error) {
    await fs.writeFile(failurePath, JSON.stringify({
      error: String(error),
      errorDetails: error?.details,
      adaptiveBuyerGoal,
      adaptiveBuyerGoalPolicy: goalPolicy,
      dialoguePolicy,
      sessionId,
      steps
    }, null, 2), 'utf8');
    throw error;
  } finally {
    await browser?.close();
  }
}

main();
