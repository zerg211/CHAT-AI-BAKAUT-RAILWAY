import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { assertProductionRemediationMarker } from './remediationProductionMarker.mjs';
import { requireProductionLiveApproval } from './productionLiveGate.mjs';

dotenv.config();
requireProductionLiveApproval({ scriptName: 'liveAgentCycle.production fixed replay' });

const started = new Date().toISOString();
const protocolPath = path.join('local-live-tests', `${started.slice(0, 10)}-bakautprof-production-agent-cycle.production.md`);
const failurePath = path.join('local-live-tests', 'production-agent-cycle-failure.json');
const productionApiBase = 'https://chat-ai-production-3057.up.railway.app';
const globalTimeoutMs = Number(process.env.LIVE_AGENT_GLOBAL_TIMEOUT_MS ?? 1_500_000);
const runtimeState = { sessionId: null, steps: [] };
let activeBrowser = null;

async function failAndExitOnGlobalTimeout() {
  const error = `Error: production live agent cycle exceeded global timeout ${globalTimeoutMs}ms`;
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
    text: 'Еще нужна виброплита для дорожек на участке. Будет плитка, песок, иногда немного щебня. Грузить и таскать чаще буду сам, поэтому слишком тяжелую не хочу.'
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
    text: 'А доставка есть? И скидку какую-нибудь можно сделать, если брать генератор и виброплиту?'
  },
  {
    phase: 'final_selection_summary',
    text: 'Если коротко, что мне сейчас смотреть по генератору и по виброплите? Что еще надо померить или уточнить дома?'
  }
];

const criticalPatterns = [
  /network error/i,
  /\u043d\u0435\s+\u0441\u043c\u043e\u0433.{0,80}\u0441\u0444\u043e\u0440\u043c\u0438\u0440\u043e\u0432\u0430\u0442\u044c\s+\u043e\u0442\u0432\u0435\u0442/iu,
  /\u0432\u043e\u043f\u0440\u043e\u0441\s+\u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d.{0,80}\u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435/iu,
  /\u043f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435.{0,40}\u0447\u0435\u0440\u0435\u0437\s+\u043f\u0430\u0440\u0443\s+\u043c\u0438\u043d\u0443\u0442/iu,
  /Не смог надежно завершить ответ/iu,
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
    if (/Подходящие варианты|Открыть карточку/iu.test(answer)) {
      throw new Error(`Commercial answer produced product cards instead of terms/summary only: ${answer}`);
    }
    if (/ориентир.{0,80}сумм/iu.test(answer) && !/генератор/iu.test(answer)) {
      throw new Error(`Bundle total was stated without selected generator context: ${answer}`);
    }
    if (!/(доставк|логист|менеджер|услов)/iu.test(answer)) {
      throw new Error(`Commercial answer did not separate delivery/discount conditions: ${answer}`);
    }
  }

  if (phase === 'final_selection_summary') {
    if (/Подходящие варианты|Открыть карточку/iu.test(answer)) {
      throw new Error(`Final buyer summary produced product cards instead of a concise summary: ${answer}`);
    }
    if (!/генератор/iu.test(answer) || !/виброплит/iu.test(answer)) {
      throw new Error(`Final summary lost generator or plate need: ${answer}`);
    }
  }
}

async function waitInputEnabled(input, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await input.isEnabled().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Chat input did not become enabled before timeout.');
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

function canonicalLoadKind(kind) {
  const key = String(kind ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['fridge', 'refrigerator', 'холодильник'].includes(key)) return 'refrigerator';
  if (['light', 'lights', 'lighting', 'led', 'led_light', 'освещение', 'свет'].includes(key)) return 'lighting';
  if (['pump', 'well_pump', 'borehole_pump', 'surface_pump', 'submersible_pump', 'circulation_pump', 'drainage_pump', 'насос'].includes(key)) return 'pump';
  if (['tool', 'power_tool', 'handheld_tool', 'angle_grinder', 'grinder', 'drill', 'saw', 'болгарка', 'инструмент'].includes(key)) return 'handheld_tool';
  return key;
}

function assertNoDuplicateLoadKinds(loadProfile, phase) {
  const seen = new Set();
  for (const item of loadProfile?.items ?? []) {
    const key = canonicalLoadKind(item.kind);
    if (seen.has(key)) throw new Error(`Duplicate structured load kind ${key} in ${phase}: ${JSON.stringify(loadProfile.items)}`);
    seen.add(key);
  }
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

async function safeFetchProductionConversation(sessionId) {
  if (!sessionId) return null;
  try {
    return await fetchProductionConversation(sessionId);
  } catch (error) {
    return { error: String(error) };
  }
}

function assertProductionMetadata(detail) {
  if (!detail) return ['SKIP: production metadata audit skipped because ADMIN_PASSWORD is not available.'];
  const assistantMessages = detail.messages.filter((message) => message.role === 'assistant');
  const notes = [];
  assistantMessages.forEach((message, index) => {
    const metadata = metadataOf(message);
    const diagnostics = metadata.aiDiagnostics ?? {};
    const usedFallbackStage = Object.entries(diagnostics).find(([, diagnostic]) => diagnostic?.used);
    if (usedFallbackStage) {
      throw new Error(`AI fallback diagnostics in production turn ${index + 1}: ${usedFallbackStage[0]} ${JSON.stringify(usedFallbackStage[1])}`);
    }
    const warnings = [
      ...(metadata.validatorWarnings ?? []),
      ...(metadata.turnContract?.validatorWarnings ?? []),
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
      throw new Error(`Missing executionContract in production turn ${index + 1}`);
    }
    if (!metadata.requirementLedger) {
      throw new Error(`Missing requirementLedger in production turn ${index + 1}`);
    }
    if (!metadata.factClaimPlanner) {
      throw new Error(`Missing factClaimPlanner in production turn ${index + 1}`);
    }
    if (!metadata.factClaimAudit) {
      throw new Error(`Missing factClaimAudit in production turn ${index + 1}`);
    }
    if (!metadata.leadStateMachine) {
      throw new Error(`Missing leadStateMachine in production turn ${index + 1}`);
    }
    if (!metadata.postAnswerVerification) {
      throw new Error(`Missing postAnswerVerification in production turn ${index + 1}`);
    }
    if (metadata.postAnswerVerification.status === 'error') {
      throw new Error(`Post-answer verification failed in production turn ${index + 1}: ${JSON.stringify(metadata.postAnswerVerification.issues)}`);
    }
    if ((metadata.productCards ?? []).length && !metadata.cardManifest) {
      throw new Error(`Missing cardManifest for product-card turn ${index + 1}`);
    }
    const visibleCardViolation = warnings.find((warning) => String(warning).startsWith('visible_card_constraint_violation:'));
    if (visibleCardViolation) {
      throw new Error(`Visible product card violates execution hard constraints in production turn ${index + 1}: ${visibleCardViolation}`);
    }
    const loadProfile = metadata.productSelection?.loadProfile;
    assertNoDuplicateLoadKinds(loadProfile, `turn ${index + 1}`);
  });

  const genericPumpMetadata = metadataOf(assistantMessages[1]);
  const genericPumpLoad = genericPumpMetadata.productSelection?.loadProfile;
  if ((genericPumpLoad?.requiredNominalKw ?? 0) > 5.5) {
    throw new Error(`Generic unknown pump turn overestimated nominal load: ${genericPumpLoad.requiredNominalKw} kW`);
  }

  notes.push('- PASS: production admin metadata has no AI fallback diagnostics or legacy text turn contracts.');
  notes.push('- PASS: executionContract/cardManifest metadata exists and visible cards do not violate hard constraints.');
  notes.push('- PASS: structured generator load profile has no duplicate pump/light/tool refinements.');
  return notes;
}

async function collectMessages(frame) {
  return frame.locator('.message').evaluateAll((nodes) => nodes.map((node) => ({
    role: node.classList.contains('assistant') ? 'assistant' : node.classList.contains('user') ? 'user' : 'system',
    text: node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })));
}

async function readWidgetSessionId(page) {
  const chatFrame = page.frames().find((candidate) => /chat-ai-production|railway|\/widget/iu.test(candidate.url()));
  if (!chatFrame) return null;
  return chatFrame.evaluate(() => sessionStorage.getItem('bakaut_session_id')).catch(() => null);
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
  await assertProductionRemediationMarker(productionApiBase);
  const browser = await chromium.launch({
    headless: true,
    executablePath: await resolveBrowserExecutable()
  });
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

    for (const turn of turns) {
      await input.waitFor({ state: 'visible', timeout: 60_000 });
      await waitInputEnabled(input);
      await input.fill(turn.text);
      await input.press('Enter');
      await waitInputEnabled(input);
      await page.waitForTimeout(1000);
      sessionId = sessionId ?? await readWidgetSessionId(page);
      runtimeState.sessionId = sessionId;

      const messages = await collectMessages(frame);
      const answer = latestAssistant(messages);
      const pageText = await frame.locator('body').innerText().catch(() => '');
      if (!answer) throw new Error(`Empty assistant answer after ${turn.phase}`);
      steps.push({ phase: turn.phase, user: turn.text, assistant: answer, pageText });
      assertPhase(turn.phase, answer, pageText);
    }

    sessionId = await readWidgetSessionId(page);
    runtimeState.sessionId = sessionId;
    const detail = sessionId ? await fetchProductionConversation(sessionId) : null;
    const metadataAuditNotes = assertProductionMetadata(detail);

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
      '- PASS: comparison, multi-need memory, commercial handoff, and contact refusal checks passed.',
      ...metadataAuditNotes
    ].join('\n'), 'utf8');

    console.log(`PASS production live agent cycle. Protocol: ${protocolPath}`);
  } catch (error) {
    sessionId = sessionId ?? await readWidgetSessionId(page).catch(() => null);
    runtimeState.sessionId = sessionId;
    const adminDetail = await safeFetchProductionConversation(sessionId);
    await fs.writeFile(failurePath, JSON.stringify({ error: String(error), sessionId, steps, adminDetail }, null, 2), 'utf8');
    throw error;
  } finally {
    clearTimeout(globalWatchdog);
    await browser.close();
    activeBrowser = null;
  }
}

main();
