import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { assertProductionRemediationMarker } from './remediationProductionMarker.mjs';

dotenv.config();

const productionApiBase = 'https://chat-ai-production-3057.up.railway.app';
const started = new Date().toISOString();
const safeStamp = started.replace(/[:.]/g, '-');
const protocolPath = path.join('local-live-tests', `${started.slice(0, 10)}-production-876-agentic-remediation-${safeStamp}.production.md`);
const failurePath = path.join('local-live-tests', 'production-876-remediation-failure.json');
const globalTimeoutMs = Number(process.env.LIVE_AGENT_GLOBAL_TIMEOUT_MS ?? 1_500_000);
const runtimeState = { sessionId: null, steps: [] };
let activeBrowser = null;

async function failAndExitOnGlobalTimeout() {
  const error = `Error: production #876 live agent cycle exceeded global timeout ${globalTimeoutMs}ms`;
  try {
    await fs.mkdir('local-live-tests', { recursive: true });
    await fs.writeFile(
      failurePath,
      JSON.stringify({ error, sessionId: runtimeState.sessionId, steps: runtimeState.steps }, null, 2),
      'utf8'
    );
  } catch (writeError) {
    console.error(`Failed to write timeout artifact: ${writeError}`);
  }
  try {
    await activeBrowser?.close();
  } catch {
    // process is exiting
  }
  console.error(error);
  process.exit(1);
}

const globalWatchdog = setTimeout(() => {
  void failAndExitOnGlobalTimeout();
}, globalTimeoutMs);
globalWatchdog.unref?.();

const turns = [
  { phase: 'engine_comparison_no_random_cards', text: 'Сравните две модели двигатель бадуин и дусан', expect: 'noCards' },
  { phase: 'exact_tss_availability_lookup', text: 'Есть в наличии ТСС 10 кВт бензин?', expect: 'availability' },
  { phase: 'phase_requirement_220', text: 'Нужен 220 В, однофазный.', expect: 'selectionMayStart' },
  { phase: 'range_availability_selection', text: 'А что есть в наличии от 8 до 10 кВт?', expect: 'cards' },
  { phase: 'selection_with_delivery_no_phone_pressure', text: 'Подберите из наличия ТСС 8-10 кВт 220 и посчитайте доставку до Ейска', expect: 'cardsDelivery' },
  { phase: 'contact_refusal_continue_selection', text: 'Нет, просто покажите варианты', expect: 'cardsNoLeadPressure' }
];

const criticalPatterns = [
  /network error/i,
  /\u043d\u0435\s+\u0441\u043c\u043e\u0433.{0,80}\u0441\u0444\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u0442\u044c\s+\u043e\u0442\u0432\u0435\u0442/iu,
  /\u0432\u043e\u043f\u0440\u043e\u0441\s+\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d.{0,80}\u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435/iu,
  /\u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435.{0,40}\u0447\u0435\u0440\u0435\u0437\s+\u043f\u0430\u0440\u0443\s+\u043c\u0438\u043d\u0443\u0442/iu,
  /не смог надежно завершить ответ/iu,
  /ответ не успел/iu,
  /server finished without a done payload/i,
  /\bundefined\b|\bnull\b/i
];

function latestAssistant(messages) {
  return [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
}

function assertNoLeadPressure(answer, phase) {
  if (/остав(?:ь|ьте|ить).{0,80}(телефон|номер|контакт)|напишите.{0,80}(телефон|номер|имя)|как вас зовут|ваш номер/iu.test(answer)) {
    throw new Error(`Lead pressure in ${phase}: ${answer}`);
  }
}

function assertNoStrict220AnswerContradiction(answer, phase) {
  const badSentences = answer
    .split(/(?<=[.!?\n])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => /тр[её]х\s*фаз|тр[её]хфаз|230\s*\/\s*400|220\s*\/\s*380|380\s*\/\s*220|380\s*В|400\s*В/iu.test(sentence))
    .filter((sentence) => !/(?:не\s+(?:показыв|бер[уеё]м|рассматрива|подход|нужн)|исключ|отсеял|только\s+однофаз|без\s+тр[её]хфаз)/iu.test(sentence));
  if (badSentences.length) {
    throw new Error(`Strict 220 V answer contradiction in ${phase}: ${badSentences.join(' ')}`);
  }
}

function assertNoCriticalText(text, phase) {
  for (const pattern of criticalPatterns) {
    if (pattern.test(text)) throw new Error(`Critical failure pattern ${pattern} in ${phase}: ${text}`);
  }
}

function hasCardUi(pageText) {
  return /Открыть карточку|Подходящие варианты|\bшт\./iu.test(pageText);
}

function assertPhase(step) {
  const { phase, expect, answer, pageText, cardCount, productText } = step;
  assertNoCriticalText(answer, phase);

  if (expect === 'noCards') {
    if (cardCount > 0 || productText.trim()) throw new Error(`Engine comparison produced product cards in ${phase}.`);
    if (/Husqvarna|виброплит|алмазн/iu.test(pageText)) throw new Error(`Engine comparison leaked unrelated product context in ${phase}.`);
    if (!/(Baudouin|Doosan|двигател|бадуин|дусан)/iu.test(answer)) throw new Error(`Engine comparison lost topic: ${answer}`);
    if (!/(in general|typically|usually|resource|service|spare|load|industrial|Baudouin[\s\S]{0,300}Doosan|Doosan[\s\S]{0,300}Baudouin|\u0432\s+\u0446\u0435\u043b\u043e\u043c|\u043e\u0431\u044b\u0447\u043d|\u0440\u0435\u0441\u0443\u0440\u0441|\u0441\u0435\u0440\u0432\u0438\u0441|\u0437\u0430\u043f\u0447\u0430\u0441\u0442|\u043d\u0430\u0433\u0440\u0443\u0437|\u043f\u0440\u043e\u043c\u044b\u0448\u043b)/iu.test(answer)) {
      throw new Error(`Engine comparison was clarification-only instead of a useful general answer: ${answer}`);
    }
  }

  if (expect === 'availability' && !/(налич|каталог|карточк|модель|ТСС|TSS)/iu.test(answer)) {
    throw new Error(`Availability lookup did not discuss catalog/availability evidence: ${answer}`);
  }
  if (phase === 'exact_tss_availability_lookup') {
    const availabilityEvidence = `${answer}\n${productText}`;
    if (!/SGG\s*10000EHA|SGG\s*10000EH3A|SGG\s*11000E3Ui/iu.test(availabilityEvidence)) {
      throw new Error(`TSS 10 kW lookup did not surface 10 kW catalog models: ${availabilityEvidence}`);
    }
    if (/SGG\s*8000|SGG\s*17000|15[,.]5\s*кВт/iu.test(productText)) {
      throw new Error(`TSS 10 kW lookup exposed non-10 kW visible cards: ${productText}`);
    }
  }

  if (expect === 'selectionMayStart' && !/(220|однофаз|вариант|кВт|ТСС|TSS|уточн)/iu.test(answer)) {
    throw new Error(`220 V requirement was not acknowledged: ${answer}`);
  }
  if (phase === 'phase_requirement_220') {
    const phaseEvidence = `${answer}\n${productText}`;
    if (!/SGG\s*10000EHA/iu.test(phaseEvidence)) {
      throw new Error(`220 V follow-up did not surface the matching one-phase 10 kW model: ${phaseEvidence}`);
    }
    if (/SGG\s*8000EH3|SGG\s*17000|тр[её]х\s*фаз|тр[её]хфаз|230\s*\/\s*400|380\s*В|400\s*В|15[,.]5\s*кВт/iu.test(productText)) {
      throw new Error(`220 V follow-up exposed incompatible visible cards: ${productText}`);
    }
  }

  if (expect === 'cards' || expect === 'cardsDelivery' || expect === 'cardsNoLeadPressure') {
    if (cardCount < 1) throw new Error(`Expected catalog product cards in ${phase}, got none.`);
    assertNoStrict220AnswerContradiction(answer, phase);
    if (/тр[её]х\s*фаз|тр[её]хфаз|230\s*\/\s*400|220\s*\/\s*380|380\s*\/\s*220|380\s*В|400\s*В/iu.test(productText)) {
      throw new Error(`Strict 220 V selection exposed a mixed 220/380 product in ${phase}: ${productText}`);
    }
    if (/12000|12[,.]0?\s*кВт|12\s*kW/iu.test(productText)) {
      throw new Error(`Strict 8-10 kW selection exposed a 12 kW product in ${phase}: ${productText}`);
    }
  }

  if (phase === 'range_availability_selection') {
    const rangeEvidence = `${answer}\n${productText}`;
    for (const required of [/SGG\s*9000ELA/iu, /SGG\s*10000EI/iu, /SGG\s*10000EHA/iu]) {
      if (!required.test(rangeEvidence)) throw new Error(`8-10 kW TSS range omitted expected catalog model ${required}: ${rangeEvidence}`);
    }
    if (/12000|12[,.]0?\s*кВт|12\s*kW/iu.test(answer)) {
      throw new Error(`8-10 kW range answer discussed 12 kW as a catalog variant: ${answer}`);
    }
  }

  if (expect === 'cardsDelivery') {
    if (!/доставк/iu.test(answer)) throw new Error(`Delivery turn did not answer delivery part: ${answer}`);
    if (!/(логист|логистик|свер|провер|уточн|услов|стоимост)/iu.test(answer)) {
      throw new Error(`Delivery answer did not keep final terms with first-person stock/logistics verification: ${answer}`);
    }
    assertNoLeadPressure(answer, phase);
  }

  if (expect === 'cardsNoLeadPressure') {
    assertNoLeadPressure(answer, phase);
    if (!/(вариант|подход|220|кВт|ТСС|TSS|покаж)/iu.test(answer)) {
      throw new Error(`Contact refusal did not continue product selection: ${answer}`);
    }
  }
}

async function waitInputEnabled(input, timeoutMs = 420_000) {
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

async function collectProductText(frame, skip = 0) {
  return frame.locator('.product-card').evaluateAll((nodes, start) =>
    nodes
      .slice(Number(start) || 0)
      .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .join('\n'), skip
  ).catch(() => '');
}

async function readWidgetSessionId(page) {
  const chatFrame = page.frames().find((candidate) => /chat-ai-production|railway|\/widget/iu.test(candidate.url()));
  if (!chatFrame) return null;
  return chatFrame.evaluate(() => sessionStorage.getItem('bakaut_session_id')).catch(() => null);
}

async function fetchProductionConversation(sessionId) {
  const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
  if (!token) throw new Error('ADMIN_PASSWORD or ADMIN_API_KEY is required for metadata audit.');
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

function assertProductionMetadata(detail) {
  const assistantMessages = detail.messages.filter((message) => message.role === 'assistant');
  if (assistantMessages.length < turns.length) throw new Error(`Expected at least ${turns.length} assistant turns, got ${assistantMessages.length}.`);

  assistantMessages.forEach((message, index) => {
    const metadata = metadataOf(message);
    if (metadata.recovered || metadata.answerGenerationFallback === true || metadata.answerGenerationFallback?.used || metadata.recoveryAttempts) {
      throw new Error(`Production turn ${index + 1} used recovery/fallback path instead of normal agent flow.`);
    }
    const diagnostics = metadata.aiDiagnostics ?? {};
    const usedFallbackStage = Object.entries(diagnostics).find(([, diagnostic]) => diagnostic?.used);
    if (usedFallbackStage) throw new Error(`AI fallback diagnostics in production turn ${index + 1}: ${usedFallbackStage[0]}`);
    const contract = metadata.turnContract;
    if (!contract?.taskType || !contract?.catalogAction || !contract?.productCardsPolicy) {
      throw new Error(`Production metadata missing new semantic contract fields in turn ${index + 1}.`);
    }
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
    if (warnings.includes('contract_source:legacy_text_fallback')) {
      throw new Error(`Legacy text contract fallback in production turn ${index + 1}`);
    }
    if (!metadata.executionContract) {
      throw new Error(`Production metadata missing executionContract in turn ${index + 1}.`);
    }
    if (!metadata.requirementLedger) {
      throw new Error(`Production metadata missing requirementLedger in turn ${index + 1}.`);
    }
    if (!metadata.factClaimPlanner) {
      throw new Error(`Production metadata missing factClaimPlanner in turn ${index + 1}.`);
    }
    if (!metadata.factClaimAudit) {
      throw new Error(`Production metadata missing factClaimAudit in turn ${index + 1}.`);
    }
    if (!metadata.leadStateMachine) {
      throw new Error(`Production metadata missing leadStateMachine in turn ${index + 1}.`);
    }
    if (!metadata.postAnswerVerification) {
      throw new Error(`Production metadata missing postAnswerVerification in turn ${index + 1}.`);
    }
    if (metadata.postAnswerVerification.status === 'error') {
      throw new Error(`Post-answer verification failed in turn ${index + 1}: ${JSON.stringify(metadata.postAnswerVerification.issues)}`);
    }
    if ((metadata.productCards ?? []).length && !metadata.cardManifest) {
      throw new Error(`Production metadata missing cardManifest for product-card turn ${index + 1}.`);
    }
    const visibleCardViolation = warnings.find((warning) => String(warning).startsWith('visible_card_constraint_violation:'));
    if (visibleCardViolation) {
      throw new Error(`Visible product card violates execution hard constraints in turn ${index + 1}: ${visibleCardViolation}`);
    }
  });
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
      // try next browser
    }
  }
  return undefined;
}

async function main() {
  await fs.mkdir('local-live-tests', { recursive: true });
  await assertProductionRemediationMarker(productionApiBase);
  const browser = await chromium.launch({ headless: true, executablePath: await resolveBrowserExecutable() });
  activeBrowser = browser;
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const steps = runtimeState.steps;
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
      await input.fill(turn.text);
      await input.press('Enter');
      await waitInputEnabled(input);
      await page.waitForTimeout(1000);

      const messages = await collectMessages(frame);
      const answer = latestAssistant(messages);
      const pageText = await frame.locator('body').innerText().catch(() => '');
      const totalCardCount = await frame.locator('.product-card').count().catch(() => 0);
      const productText = await collectProductText(frame, previousProductCardCount);
      const cardCount = Math.max(0, totalCardCount - previousProductCardCount);
      previousProductCardCount = totalCardCount;
      const step = { ...turn, answer, pageText, productText, cardCount };
      if (!answer) throw new Error(`Empty assistant answer after ${turn.phase}`);
      assertPhase(step);
      steps.push(step);
    }

    sessionId = await readWidgetSessionId(page);
    runtimeState.sessionId = sessionId;
    if (!sessionId) throw new Error('Widget session id was not available for production metadata audit.');
    const detail = await fetchProductionConversation(sessionId);
    assertProductionMetadata(detail);

    await fs.writeFile(protocolPath, [
      '# Production #876 agentic remediation live check',
      '',
      `URL: https://bakautprof.ru/`,
      `Session: ${sessionId}`,
      `Date: ${new Date().toISOString()}`,
      '',
      ...steps.flatMap((step, index) => [
        `## Turn ${index + 1}: ${step.phase}`,
        '',
        `**User:** ${step.text}`,
        '',
        `**Assistant:** ${step.answer}`,
        '',
        `Cards visible in widget after turn: ${step.cardCount}`
      ]),
      '',
      '## Audit',
      '',
      '- PASS: production iframe #876 dialogue completed.',
      '- PASS: no unrelated cards for engine comparison.',
      '- PASS: strict 220 V selection did not expose mixed 220/380 products.',
      '- PASS: delivery/availability answer kept first-person stock/logistics verification without phone pressure.',
      '- PASS: production metadata contains new semantic contract fields and no AI fallback diagnostics.'
    ].join('\n'), 'utf8');

    console.log(`PASS production #876 live agent cycle. Protocol: ${protocolPath}`);
  } catch (error) {
    runtimeState.sessionId = sessionId;
    await fs.writeFile(failurePath, JSON.stringify({ error: String(error), sessionId, steps }, null, 2), 'utf8');
    throw error;
  } finally {
    clearTimeout(globalWatchdog);
    await browser.close();
    activeBrowser = null;
  }
}

main();
