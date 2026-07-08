import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const productionApiBase = 'https://chat-ai-production-3057.up.railway.app';
const siteUrl = 'https://bakautprof.ru/';
const expectedCommit = process.env.EXPECTED_PRODUCTION_COMMIT;
const started = new Date().toISOString();
const safeStamp = started.replace(/[:.]/g, '-');
const artifactDir = '.agent/tasks/2026-07-08-agentic-dialogue-fixes';
const jsonPath = path.join(artifactDir, `production-dialogues-${safeStamp}.json`);
const mdPath = path.join(artifactDir, `production-dialogues-${safeStamp}.production.md`);

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function hasAny(text, fragments) {
  const lower = cleanText(text).toLocaleLowerCase('ru-RU');
  return fragments.some((fragment) => lower.includes(fragment.toLocaleLowerCase('ru-RU')));
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
      // try next
    }
  }
  return undefined;
}

async function fetchHealth() {
  const response = await fetch(`${productionApiBase}/api/health`);
  if (!response.ok) throw new Error(`health failed: ${response.status}`);
  const health = await response.json();
  const sha = String(health.runtime?.commitSha ?? '');
  if (expectedCommit && sha !== expectedCommit) throw new Error(`production commit mismatch: expected ${expectedCommit}, got ${sha}`);
  return health;
}

async function fetchProductionConversation(sessionId) {
  const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
  if (!token || !sessionId) return null;
  const response = await fetch(`${productionApiBase}/api/admin/conversations/${sessionId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) return { error: `admin detail failed: ${response.status}` };
  return response.json();
}

async function waitInputEnabled(input, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await input.isEnabled().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error('chat input did not become enabled');
}

async function collectMessages(frame) {
  return frame.locator('.message').evaluateAll((nodes) => nodes.map((node) => ({
    role: node.classList.contains('assistant') ? 'assistant' : node.classList.contains('user') ? 'user' : 'system',
    text: node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })));
}

async function collectCards(frame) {
  return frame.locator('.product-card').evaluateAll((nodes) => nodes.map((node) =>
    node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  )).catch(() => []);
}

async function readWidgetSessionId(page) {
  const chatFrameElement = page.locator('iframe#bakaut-ai-widget-frame, iframe[src*="chat-ai-production"], iframe[src*="railway"], iframe[src*="/widget"]').first();
  const chatFrameHandle = await chatFrameElement.elementHandle().catch(() => null);
  const chatFrame = (chatFrameHandle ? await chatFrameHandle.contentFrame().catch(() => null) : null) ??
    page.frames().find((candidate) => /chat-ai-production|railway|\/widget/iu.test(candidate.url()));
  if (chatFrame) return chatFrame.evaluate(() => sessionStorage.getItem('bakaut_session_id')).catch(() => null);
  return page.evaluate(() => sessionStorage.getItem('bakaut_session_id')).catch(() => null);
}

async function openChat(browser) {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.locator('#bakaut-ai-widget-launcher').waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator('#bakaut-ai-widget-launcher').click({ timeout: 20_000 }).catch(() => undefined);
  const iframeElement = page.locator('iframe#bakaut-ai-widget-frame, iframe[src*="chat-ai-production"], iframe[src*="railway"], iframe[src*="/widget"]').first();
  let frame = null;
  try {
    await iframeElement.waitFor({ state: 'attached', timeout: 60_000 });
    const iframeHandle = await iframeElement.elementHandle();
    frame = iframeHandle ? await iframeHandle.contentFrame() : null;
  } catch {
    frame = null;
  }
  const chatRoot = frame ?? page;
  if (frame) {
    await chatRoot.getByRole('button').first().click({ timeout: 20_000 }).catch(() => undefined);
  }
  const input = chatRoot.locator('textarea, input[type="text"]').first();
  await input.waitFor({ state: 'visible', timeout: 60_000 });
  await waitInputEnabled(input);
  return { page, frame: chatRoot, input };
}

async function sendTurn(page, frame, input, text) {
  const beforeAssistantCount = await frame.locator('.message.assistant').count().catch(() => 0);
  const beforeCardCount = await frame.locator('.product-card').count().catch(() => 0);
  await waitInputEnabled(input);
  await input.fill(text);
  await input.press('Enter');
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const assistantCount = await frame.locator('.message.assistant').count().catch(() => 0);
    if (assistantCount > beforeAssistantCount && await input.isEnabled().catch(() => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await page.waitForTimeout(1200);
  const messages = await collectMessages(frame);
  const cards = await collectCards(frame);
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
  return {
    user: text,
    assistant: cleanText(assistant),
    newCards: cards.slice(beforeCardCount).map(cleanText),
    allCards: cards.map(cleanText)
  };
}

async function submitLeadForm(frame, leadForm) {
  const toggle = frame.getByRole('button', { name: /Оставить контакт/i }).first();
  if (await toggle.isVisible().catch(() => false)) await toggle.evaluate((element) => element.click());
  await frame.locator('.lead-panel.expanded input').first().waitFor({ state: 'visible', timeout: 10_000 });
  await frame.getByLabel('Имя').fill(leadForm.name);
  await frame.getByLabel('Телефон').fill(leadForm.phone);
  await frame.getByLabel('Email').fill(leadForm.email);
  await frame.getByLabel('Вопрос').fill(leadForm.question);
  const submit = frame.locator('.lead-panel.expanded button[type="submit"]').first();
  await submit.waitFor({ state: 'visible', timeout: 10_000 });
  await submit.evaluate((element) => element.click());
  await Promise.race([
    frame.locator('.form-note.ok').waitFor({ state: 'visible', timeout: 60_000 }),
    frame.locator('.form-note.bad').waitFor({ state: 'visible', timeout: 60_000 })
  ]);
  const panelText = cleanText(await frame.locator('.lead-panel').innerText());
  if (await frame.locator('.form-note.bad').isVisible().catch(() => false)) {
    throw new Error(`lead form failed: ${panelText}`);
  }
  return panelText;
}

function auditTurn(sessionName, phase, turn, adminMessage) {
  const issues = [];
  const answer = turn.assistant;
  const cardsText = turn.newCards.join('\n');
  const combined = `${answer}\n${cardsText}`;
  const metadata = adminMessage?.metadata ?? {};
  const warnings = [
    ...(metadata.cardSelection?.warnings ?? []),
    ...((metadata.toolResults ?? []).flatMap((result) => result.warnings ?? []))
  ];

  if (!answer) issues.push('empty assistant answer');
  if (hasAny(answer, ['undefined', 'null', 'network error', 'server finished without a done payload'])) issues.push('technical token leaked in answer');

  if (phase === 'repeat_1708_battery_1_8kw') {
    if (!hasAny(combined, ['аккумулятор', 'battery', 'APS', 'power station'])) issues.push('battery requirement not visible in answer/cards');
    if (hasAny(cardsText, ['бензин', 'дизель', 'gasoline', 'diesel'])) issues.push('visible cards include gasoline/diesel despite battery requirement');
    if (!turn.newCards.length) issues.push('no visible product cards for direct battery station request');
  }

  if (phase === 'repeat_1707_battery_800') {
    if (!hasAny(combined, ['800', '0,8', '0.8', 'APS'])) issues.push('800 watt requirement not reflected in answer/cards');
    if (hasAny(cardsText, ['24 кВт', '100 кВт', 'дизель', 'бензин'])) issues.push('wrong fuel or oversized generator card in 800 watt battery request');
    if (hasAny(cardsText, ['APS600', '600 W', '600 Вт'])) issues.push('visible cards include a battery station below the explicit 800 W minimum');
  }

  if (phase === 'repeat_1707_crimea_after_form') {
    if (hasAny(answer, ['оставьте имя', 'оставьте телефон', 'напишите имя', 'номер телефона', 'как вас зовут'])) issues.push('asked for contact again after lead form was submitted');
    if (!hasAny(answer, ['крым', 'поставка', 'доставка', 'логист', 'уточн', 'провер'])) issues.push('did not address Crimea delivery/purchase handoff');
    if (!warnings.includes('lead_existing_session_contact_used')) issues.push('metadata did not show reuse of existing session lead');
  }

  if (phase === 'repeat_1706_sevastopol_warehouse') {
    if (hasAny(answer, ['выбранные позиции'])) issues.push('warehouse/location answer talks about selected positions');
    if (!hasAny(answer, ['севастопол', 'склад', 'филиал', 'адрес', 'налич', 'логист', 'уточн'])) issues.push('did not address Sevastopol warehouse/location question');
  }

  if (phase === 'new_plate_yard_self_loading') {
    if (!turn.newCards.length) issues.push('no product cards for concrete plate selection');
    if (hasAny(cardsText, ['400 кг', '398 кг', '500 кг'])) issues.push('showed industrial heavy plate for self-loading yard task');
  }

  if (phase === 'new_diesel_15_20kw_380') {
    if (!hasAny(combined, ['дизель', '380', '15', '20', 'кВт'])) issues.push('did not keep diesel 15-20 kW 380 V requirement');
    if (hasAny(cardsText, ['бензин', 'аккумулятор', 'battery'])) issues.push('visible cards conflict with diesel requirement');
    if (hasAny(cardsText, ['220 V', '220 В', 'single phase', 'single-phase', 'однофаз'])) issues.push('visible cards include a single-phase/220 V generator despite the 380 V requirement');
  }

  if (phase === 'new_context_switch_diamond_blade') {
    if (!hasAny(combined, ['диск', 'алмаз', 'керамогранит', '350'])) issues.push('did not switch from generator context to diamond blade request');
    if (hasAny(cardsText, ['генератор', 'электростанц'])) issues.push('generator cards leaked into diamond blade context switch');
  }

  return { sessionName, phase, issues, warnings, cards: turn.newCards };
}

async function runSession(browser, session) {
  const { page, frame, input } = await openChat(browser);
  const turns = [];
  let formSubmission = null;
  for (const item of session.turns) {
    const turn = await sendTurn(page, frame, input, item.text);
    turns.push({ phase: item.phase, ...turn });
    if (item.submitLeadFormAfter) {
      formSubmission = await submitLeadForm(frame, item.submitLeadFormAfter);
    }
  }
  const sessionId = await readWidgetSessionId(page);
  const admin = await fetchProductionConversation(sessionId);
  await page.close();
  const assistantMessages = admin?.messages?.filter((message) => message.role === 'assistant') ?? [];
  const audits = turns.map((turn, index) => auditTurn(session.name, turn.phase, turn, assistantMessages[index]));
  return { name: session.name, sessionId, turns, formSubmission, admin, audits };
}

function mdSession(result) {
  const lines = [`## ${result.name}`, `Session: ${result.sessionId ?? 'unknown'}`];
  if (result.formSubmission) lines.push(`Lead form: ${result.formSubmission}`);
  for (const turn of result.turns) {
    const audit = result.audits.find((item) => item.phase === turn.phase);
    lines.push('', `### ${turn.phase}`, `Buyer: ${turn.user}`, `Assistant: ${turn.assistant}`);
    lines.push(`Cards: ${turn.newCards.length ? turn.newCards.join(' | ') : 'none'}`);
    lines.push(`Issues: ${audit?.issues.length ? audit.issues.join('; ') : 'none'}`);
    if (audit?.warnings.length) lines.push(`Warnings: ${audit.warnings.join('; ')}`);
  }
  return lines.join('\n');
}

const sessions = [
  {
    name: 'repeat_1708',
    turns: [
      { phase: 'repeat_1708_battery_1_8kw', text: 'Нужен генератор 1-1,8 кВт аккумуляторный, выход 220 В.' }
    ]
  },
  {
    name: 'repeat_1707_with_form',
    turns: [
      {
        phase: 'repeat_1707_battery_800',
        text: 'Нужна аккумуляторная электростанция 800 ватт или больше, 220 В.',
        submitLeadFormAfter: {
          name: 'Николай',
          phone: '+7 900 000-55-17',
          email: '9955u4@gmail.ru',
          question: 'Поставка аккумуляторной станции 800 Вт или больше в Р. Крым'
        }
      },
      {
        phase: 'repeat_1707_crimea_after_form',
        text: 'И возможность поставки в Р. Крым проверьте.'
      }
    ]
  },
  {
    name: 'repeat_1706',
    turns: [
      { phase: 'repeat_1706_sevastopol_warehouse', text: 'В Севастополе у вас есть склад?' }
    ]
  },
  {
    name: 'new_plate',
    turns: [
      { phase: 'new_plate_yard_self_loading', text: 'Нужна виброплита для двора под тротуарную плитку 40 мм, сам буду грузить в багажник.' }
    ]
  },
  {
    name: 'new_diesel',
    turns: [
      { phase: 'new_diesel_15_20kw_380', text: 'Подберите дизельный генератор 15-20 кВт на 380 В для магазина, бензин не подходит.' }
    ]
  },
  {
    name: 'new_context_switch',
    turns: [
      { phase: 'repeat_1707_battery_800', text: 'Нужна аккумуляторная электростанция 800 ватт на 220 В.' },
      { phase: 'new_context_switch_diamond_blade', text: 'Стоп, генератор пока не нужен. Нужен алмазный диск 350 по керамограниту, что есть?' }
    ]
  }
];

async function main() {
  await fs.mkdir(artifactDir, { recursive: true });
  const health = await fetchHealth();
  const browser = await chromium.launch({ headless: true, executablePath: await resolveBrowserExecutable() });
  const results = [];
  try {
    for (const session of sessions) {
      const result = await runSession(browser, session);
      results.push(result);
      const issueCount = result.audits.reduce((sum, audit) => sum + audit.issues.length, 0);
      console.log(`${session.name}: issues=${issueCount}; session=${result.sessionId}`);
    }
  } finally {
    await browser.close();
  }

  const totalIssues = results.flatMap((result) => result.audits.flatMap((audit) => audit.issues.map((issue) => ({
    session: result.name,
    phase: audit.phase,
    issue
  }))));

  await fs.writeFile(jsonPath, JSON.stringify({ health, results, totalIssues }, null, 2), 'utf8');
  await fs.writeFile(mdPath, [
    '# Production Dialogue Check',
    `Started: ${started}`,
    `URL: ${siteUrl}`,
    `API: ${productionApiBase}`,
    `Commit: ${health.runtime?.commitSha}`,
    `Total issues: ${totalIssues.length}`,
    '',
    ...results.map(mdSession),
    '',
    '## Verdict',
    totalIssues.length ? totalIssues.map((item) => `- FAIL ${item.session}/${item.phase}: ${item.issue}`).join('\n') : '- PASS: all live dialogue checks passed.'
  ].join('\n'), 'utf8');

  if (totalIssues.length) {
    console.error(`FAIL production dialogue check. Protocol: ${mdPath}`);
    process.exit(1);
  }
  console.log(`PASS production dialogue check. Protocol: ${mdPath}`);
}

main().catch(async (error) => {
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, `production-dialogues-${safeStamp}.failure.json`), JSON.stringify({
    error: String(error),
    stack: error?.stack
  }, null, 2), 'utf8').catch(() => undefined);
  console.error(error);
  process.exit(1);
});
