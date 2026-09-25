import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { requireProductionLiveApproval } from './productionLiveGate.mjs';
import {
  assertProductionRuntimeMarker,
  fetchProductionHealth
} from './productionRuntimeMarker.mjs';
import { requireProductionOpenAiRuntimeReady } from './productionOpenAiRuntimePreflight.mjs';
import {
  buyerScenarioCategories,
  chooseBuyerCategory,
  codexCommandArguments,
  generateBuyerScenario,
  generateNextBuyerTurn
} from './adaptiveBuyerCodex.mjs';

const productionSiteUrl = 'https://bakautprof.ru/';
const maxSessionsAllowed = 6;
const maxTurnsAllowed = 12;
const defaultAssistantWaitMs = 420_000;
const minAssistantWaitMs = 30_000;
const maxAssistantWaitMs = 900_000;

function helpText() {
  return [
    'Adaptive live-widget buyer runner',
    '',
    'Safe default (no browser, network, Codex, or bot calls):',
    '  npm run live:adaptive-buyer -- --dry-run --sessions 3',
    '',
    'Preview run (only after the preview build is explicitly approved):',
    '  $env:ALLOW_PREVIEW_LIVE_TESTS = "1"',
    '  $env:APPROVED_PREVIEW_BUILD_SHA = "<full approved Railway commit SHA>"',
    '  $env:ADMIN_API_KEY = "<admin read token>"',
    '  npm run live:adaptive-buyer -- --live --target preview --site-url "<preview widget page>" --api-base "<preview API origin>" --sessions 3 --max-turns 8',
    '',
    'Final production run:',
    '  $env:ALLOW_PRODUCTION_LIVE_TESTS = "1"',
    '  $env:FINAL_RELEASE_LIVE_GATE = "1"',
    '  $env:ADMIN_API_KEY = "<admin read token>"',
    '  npm run live:adaptive-buyer -- --live --target production --sessions 3 --max-turns 8',
    '',
    `Targets: production defaults to ${productionSiteUrl}; preview requires --site-url and --api-base.`,
    `Each batch rotates categories: ${buyerScenarioCategories.join(', ')}.`,
    'Before each turn, the buyer generator receives the actual visible same-session messages and product cards, including any opening greeting.',
    'Buyer messages are generated one at a time in natural customer language. They contain no test hints, evaluation language, or instructions for the assistant.',
    'No prepared utterance list or lead submission is used.',
    'Live mode uses the Codex CLI account for buyer generation and the deployed widget for assistant answers. Both consume usage.',
    'Reports and per-turn screenshots are written under local-live-tests/. Captured dialogues remain HUMAN_REVIEW_PENDING until a person reviews them.'
  ].join('\n');
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[redacted-key]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .slice(0, 800);
}

function validateSiteUrl(options) {
  const rawUrl = options.siteUrl || (options.target === 'production' ? productionSiteUrl : undefined);
  if (!rawUrl) throw new Error('preview_requires_explicit_site_url');
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('site_url_must_be_https_without_credentials_or_fragment');
  }
  if (options.target === 'production') {
    if (url.href !== productionSiteUrl) throw new Error('production_target_must_use_bakautprof_ru_root');
  } else if (url.search) {
    throw new Error('preview_site_url_must_not_include_query_parameters');
  }
  return url.href;
}

function validateLiveGates(options) {
  if (options.target === 'production') {
    requireProductionLiveApproval({
      scriptName: 'Playwright adaptive live-widget buyer runner',
      adaptiveBuyer: true
    });
    return;
  }
  if (process.env.ALLOW_PREVIEW_LIVE_TESTS !== '1') {
    throw new Error('preview_live_test_requires_ALLOW_PREVIEW_LIVE_TESTS_1');
  }
  const approvedSha = process.env.APPROVED_PREVIEW_BUILD_SHA?.trim();
  if (!approvedSha || !/^[a-f0-9]{40}$/iu.test(approvedSha)) {
    throw new Error('preview_live_test_requires_full_approved_commit_sha_from_coordinator');
  }
}

function validateAdminCredential() {
  if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_API_KEY) {
    throw new Error('admin_read_token_required_for_technical_evidence');
  }
}

function validateOptions(options) {
  if (options.sessions > maxSessionsAllowed || options.maxTurns > maxTurnsAllowed) {
    throw new Error(`limits_are_${maxSessionsAllowed}_sessions_and_${maxTurnsAllowed}_turns`);
  }
  const siteUrl = validateSiteUrl(options);
  const configuredApiBase = options.apiBase || (options.target === 'production' ? process.env.PRODUCTION_API_BASE : undefined);
  const apiBase = configuredApiBase?.replace(/\/+$/u, '');
  if (apiBase) {
    const parsedApiBase = new URL(apiBase);
    if (
      parsedApiBase.protocol !== 'https:' ||
      parsedApiBase.username ||
      parsedApiBase.password ||
      parsedApiBase.pathname !== '/' ||
      parsedApiBase.search ||
      parsedApiBase.hash
    ) {
      throw new Error('api_base_must_be_https_origin_without_credentials_or_path');
    }
  }
  if (options.target === 'preview' && !apiBase) {
    throw new Error('preview_requires_explicit_api_base');
  }
  const configuredWait = process.env.LIVE_BUYER_ASSISTANT_WAIT_MS;
  const assistantWaitMs = configuredWait ? Number(configuredWait) : defaultAssistantWaitMs;
  if (!Number.isInteger(assistantWaitMs) || assistantWaitMs < minAssistantWaitMs || assistantWaitMs > maxAssistantWaitMs) {
    throw new Error(`assistant_wait_ms_must_be_${minAssistantWaitMs}_to_${maxAssistantWaitMs}`);
  }
  return { ...options, siteUrl, apiBase, assistantWaitMs };
}

function printDryRun(options) {
  const categories = Array.from({ length: options.sessions }, (_, index) => chooseBuyerCategory(index));
  console.log(JSON.stringify({
    mode: 'DRY_RUN',
    liveCalls: false,
    browserLaunch: false,
    codexCalls: false,
    widgetMessages: false,
    target: options.target,
    siteUrl: options.target === 'production' ? productionSiteUrl : (options.siteUrl || null),
    sessions: options.sessions,
    maxTurnsPerSession: options.maxTurns,
    plannedCategories: categories,
    evidenceDirectory: path.resolve('local-live-tests'),
    nextCommandRequiresExplicitLiveFlag: true
  }, null, 2));
}

async function resolveBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
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
      // Try the next system browser.
    }
  }
  return undefined;
}

async function waitForVisibleInput(frame, timeoutMs = 60_000) {
  const input = frame.locator('textarea, input[type="text"]').first();
  await input.waitFor({ state: 'visible', timeout: timeoutMs });
  return input;
}

async function chooseWidgetFrame(page) {
  for (const selector of ['#bakaut-ai-loader-launcher', '#bakaut-ai-widget-launcher']) {
    const launcher = page.locator(selector).first();
    if (await launcher.isVisible().catch(() => false)) {
      await launcher.click({ timeout: 15_000 });
      break;
    }
  }

  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    const candidates = page.frames().filter((frame) => frame !== page.mainFrame());
    for (const frame of [...candidates, page.mainFrame()]) {
      try {
        const input = await waitForVisibleInput(frame, 1_000);
        return { frame, input };
      } catch (error) {
        lastError = error;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`widget_composer_not_found:${safeError(lastError)}`);
}

async function waitForAssistantResponse(frame, input, previousAssistantCount, timeoutMs) {
  const messages = frame.locator('.message.assistant');
  const error = frame.locator('.error').first();
  const status = frame.locator('header .status').first();
  const deadline = Date.now() + timeoutMs;
  let lastResponse = '';
  let stableResponseChecks = 0;
  while (Date.now() < deadline) {
    const currentCount = await messages.count().catch(() => previousAssistantCount);
    const response = currentCount > previousAssistantCount
      ? cleanText(await messages.last().locator('.bubble').innerText().catch(() => ''))
      : '';
    stableResponseChecks = response && response === lastResponse ? stableResponseChecks + 1 : 0;
    lastResponse = response;
    const statusText = cleanText(await status.innerText().catch(() => ''));
    const online = !statusText || /онлайн|online/iu.test(statusText);
    if (response && stableResponseChecks >= 2 && online && await input.isEnabled().catch(() => false)) return response;
    const errorText = cleanText(await error.innerText().catch(() => ''));
    if (errorText && currentCount <= previousAssistantCount) {
      throw new Error(`widget_error_before_assistant_reply:${errorText.slice(0, 300)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error('widget_assistant_reply_timeout');
}

async function sendBuyerMessage(frame, input, text, timeoutMs) {
  const previousAssistantCount = await frame.locator('.message.assistant').count().catch(() => 0);
  await input.fill(text);
  const submit = frame.locator('form.composer button[type="submit"]').first();
  if (await submit.count().catch(() => 0)) {
    await submit.waitFor({ state: 'visible', timeout: 10_000 });
    if (!await submit.isEnabled()) throw new Error('widget_submit_disabled_after_fill');
    await submit.click();
  } else {
    await input.press('Enter');
  }
  return waitForAssistantResponse(frame, input, previousAssistantCount, timeoutMs);
}

async function collectVisibleMessages(frame) {
  return frame.locator('.message').evaluateAll((nodes) => nodes.map((node) => ({
    role: node.classList.contains('assistant') ? 'assistant' : node.classList.contains('user') ? 'buyer' : 'system',
    text: node.querySelector('.bubble')?.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
  })).filter((message) => message.text));
}

async function collectVisibleCards(frame) {
  return frame.locator('.product-card:visible').evaluateAll((nodes) => nodes
    .map((node) => node.textContent?.replace(/\s+/gu, ' ').trim() ?? '')
    .filter(Boolean));
}

async function getWidgetSessionId(frame) {
  return frame.evaluate(() => sessionStorage.getItem('bakaut_session_id')).catch(() => null);
}

function deriveApiBase(page, explicitApiBase, siteUrl) {
  if (explicitApiBase) return explicitApiBase;
  const widgetFrame = page.frames().find((frame) => frame !== page.mainFrame() && /(?:widget|chat|railway)/iu.test(frame.url()));
  return widgetFrame ? new URL(widgetFrame.url()).origin : new URL(siteUrl).origin;
}

async function fetchHealth(apiBase) {
  const result = await fetchProductionHealth(apiBase, 20_000);
  if (!result.ok || !result.parsed?.runtime) throw new Error(`widget_api_health_failed:${result.status}`);
  return result.parsed;
}

async function assertPreviewBuild(apiBase) {
  const expectedSha = process.env.APPROVED_PREVIEW_BUILD_SHA.trim().toLocaleLowerCase('en');
  const health = await fetchHealth(apiBase);
  const actualSha = String(health.runtime.commitSha ?? '').toLocaleLowerCase('en');
  if (!actualSha || actualSha !== expectedSha) {
    throw new Error('preview_build_sha_does_not_match_approved_sha');
  }
  return { health, approvedSha: expectedSha, actualSha };
}

async function assertBuildUnchanged(apiBase, initialSha) {
  if (!initialSha) return;
  const health = await fetchHealth(apiBase);
  const currentSha = String(health.runtime.commitSha ?? '');
  if (currentSha !== initialSha) throw new Error('deployment_changed_during_live_buyer_run');
}

function timeoutSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

async function fetchAdminEvidence(apiBase, sessionId) {
  const token = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
  const headers = { authorization: `Bearer ${token}` };
  const sessionUrl = `${apiBase}/api/admin/conversations/${encodeURIComponent(sessionId)}`;
  const [sessionResponse, traceResponse] = await Promise.all([
    fetch(sessionUrl, { headers, signal: timeoutSignal(30_000), redirect: 'error' }),
    fetch(`${sessionUrl}/agent-traces?limit=200`, { headers, signal: timeoutSignal(30_000), redirect: 'error' })
  ]);
  if (!sessionResponse.ok) throw new Error(`admin_conversation_read_failed:${sessionResponse.status}`);
  const sessionData = await sessionResponse.json();
  const traces = traceResponse.ok ? await traceResponse.json() : null;
  const agentTraces = traces?.traces ?? sessionData.agentTraces ?? [];
  const messages = (sessionData.messages ?? []).map((message) => ({
    id: message.id ?? null,
    role: message.role ?? null,
    content: message.content ?? null,
    createdAt: message.createdAt ?? null,
    metadata: message.metadata ?? {}
  }));
  const hasAgentTraces = agentTraces.length > 0;
  return {
    status: hasAgentTraces ? 'AVAILABLE' : 'BLOCKED',
    reason: hasAgentTraces ? `captured_${agentTraces.length}_agent_traces` : 'required_agent_traces_missing',
    session: sessionData.session ?? null,
    turns: sessionData.turns ?? [],
    messages,
    agentTraces,
    traceEndpointStatus: traceResponse.status
  };
}

async function captureSession({ page, frame, input, sessionIndex, options, apiBase, runDir }) {
  const sessionDir = path.join(runDir, `session-${String(sessionIndex + 1).padStart(2, '0')}`);
  const screenshotDir = path.join(sessionDir, 'screenshots');
  await fs.mkdir(screenshotDir, { recursive: true });

  const category = chooseBuyerCategory(sessionIndex);
  const seed = crypto.randomUUID();
  let profile = null;
  const steps = [];
  const buyerMessages = [];
  let outcome = 'max_turns_reached';
  let sessionId = null;
  let failure = null;

  try {
    profile = await generateBuyerScenario({ category, seed });
    for (let turnIndex = 0; turnIndex < options.maxTurns; turnIndex += 1) {
      // Read the current widget state before every generation, including an initial greeting/cards.
      const currentVisibleMessages = await collectVisibleMessages(frame);
      const currentVisibleCards = await collectVisibleCards(frame);
      const next = await generateNextBuyerTurn({
        profile,
        visibleTranscript: currentVisibleMessages.map(({ role, text }) => ({ role, text })),
        visibleCards: currentVisibleCards,
        turnIndex,
        maxTurns: options.maxTurns,
        previousMessages: buyerMessages
      });
      if (next.done) {
        outcome = steps.length ? 'buyer_goal_closed' : 'buyer_generated_no_opening';
        break;
      }

      buyerMessages.push(next.message);
      const step = {
        turn: turnIndex + 1,
        buyer: next.message,
        assistant: '',
        visibleCards: [],
        visibleMessages: [],
        screenshot: null
      };
      steps.push(step);
      try {
        step.assistant = await sendBuyerMessage(frame, input, next.message, options.assistantWaitMs);
      } catch (error) {
        step.error = safeError(error);
      }
      step.visibleMessages = await collectVisibleMessages(frame).catch((error) => {
        step.visibleMessagesError = safeError(error);
        return [];
      });
      step.visibleCards = await collectVisibleCards(frame).catch((error) => {
        step.visibleCardsError = safeError(error);
        return [];
      });
      sessionId = await getWidgetSessionId(frame) || sessionId;
      const screenshotPath = path.join(screenshotDir, `turn-${String(turnIndex + 1).padStart(2, '0')}.png`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
        step.screenshot = path.relative(runDir, screenshotPath).replace(/\\/gu, '/');
      } catch (error) {
        step.screenshotError = safeError(error);
      }
      if (step.error || step.screenshotError || step.visibleMessagesError || step.visibleCardsError) {
        throw new Error(step.error || step.screenshotError || step.visibleMessagesError || step.visibleCardsError);
      }
      console.log(`session ${sessionIndex + 1}/${options.sessions}, turn ${turnIndex + 1}/${options.maxTurns}: widget reply captured`);
    }

    if (steps.length && steps.length < options.maxTurns && outcome === 'max_turns_reached') {
      outcome = 'buyer_goal_closed';
    }
  } catch (error) {
    outcome = 'BLOCKED';
    failure = safeError(error);
    sessionId = await getWidgetSessionId(frame) || sessionId;
  }

  let adminEvidence = { status: 'NOT_RUN', reason: 'session_id_unavailable' };
  if (sessionId) {
    try {
      adminEvidence = await fetchAdminEvidence(apiBase, sessionId);
    } catch (error) {
      adminEvidence = { status: 'BLOCKED', reason: safeError(error) };
    }
  }
  const sessionResult = {
    target: options.target,
    siteUrl: options.siteUrl,
    category,
    seed,
    profile,
    outcome,
    sessionId,
    steps,
    adminEvidence,
    failure,
    readiness: outcome === 'BLOCKED' || outcome === 'buyer_generated_no_opening' || adminEvidence.status !== 'AVAILABLE'
      ? 'BLOCKED'
      : 'HUMAN_REVIEW_PENDING'
  };
  await fs.writeFile(path.join(sessionDir, 'evidence.json'), JSON.stringify(sessionResult, null, 2), 'utf8');
  return sessionResult;
}

function markdownRunReport(run) {
  const lines = [
    `# Adaptive live-widget buyer run (${run.target})`,
    '',
    `- Started: ${run.startedAt}`,
    `- Site: ${run.siteUrl}`,
    `- API origin: ${run.apiBase}`,
    `- Runtime build SHA: ${run.buildSha ?? 'unavailable'}`,
    `- Coordinator-approved build SHA: ${run.approvedBuildSha ?? 'not applicable'}`,
    `- Run status: ${run.status}`,
    `- Readiness: ${run.readiness}`,
    '- Dialogue source: buyer profile and each single message generated at run time; no prepared turn list.',
    '- Personal contact data or lead submission: disabled.',
    '',
    '## Review rule',
    '',
    'Read every screenshot and compare the buyer-visible answer/cards with the matching admin metadata and traces. Automation does not mark a production or preview dialogue as accepted.',
    ''
  ];

  for (const session of run.sessions) {
    lines.push(
      `## Session ${session.sessionIndex}: ${session.category}`,
      '',
      `- Outcome: ${session.outcome}`,
      `- Session ID: ${session.sessionId ?? 'unavailable'}`,
      `- Admin evidence: ${session.adminEvidence.status}`,
      `- Readiness: ${session.readiness}`,
      `- Private buyer profile: ${JSON.stringify(session.profile)}`,
      ''
    );
    if (session.failure) lines.push(`- Runner failure: ${session.failure}`, '');
    for (const step of session.steps) {
      lines.push(
        `### Turn ${step.turn}`,
        '',
        `**Buyer:** ${step.buyer}`,
        '',
        `**Assistant:** ${step.assistant}`,
        '',
        '**Visible cards:**',
        '',
        ...(step.visibleCards.length ? step.visibleCards.map((card) => `- ${card}`) : ['- none']),
        '',
        `**Screenshot:** ${step.screenshot ? `[${step.screenshot}](${step.screenshot})` : 'unavailable'}`,
        '',
        '**Manual review:**',
        '',
        '- [ ] Factually correct and useful',
        '- [ ] Product cards match the answer and current buyer needs',
        '- [ ] Technical metadata/traces explain the buyer-visible result',
        '- Notes:',
        ''
      );
    }
    lines.push('### Technical evidence', '', `- ${session.adminEvidence.status}: ${session.adminEvidence.reason ?? 'conversation and agent traces captured'}`, '');
  }
  return `${lines.join('\n')}\n`;
}

async function writeRunArtifacts(run) {
  await fs.mkdir(run.runDir, { recursive: true });
  const jsonPath = path.join(run.runDir, 'evidence.json');
  const markdownPath = path.join(run.runDir, `report.${run.target === 'production' ? 'production' : 'preview'}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(run, null, 2), 'utf8');
  await fs.writeFile(markdownPath, markdownRunReport(run), 'utf8');
  return { jsonPath, markdownPath };
}

async function runLive(options) {
  validateLiveGates(options);
  validateAdminCredential();

  let browser;
  const startedAt = new Date().toISOString();
  const safeStamp = startedAt.replace(/[:.]/gu, '-');
  const runDir = path.resolve('local-live-tests', `${safeStamp}-adaptive-buyer-${options.target}`);
  const run = {
    mode: 'LIVE',
    target: options.target,
    siteUrl: options.siteUrl,
    apiBase: options.apiBase ?? null,
    buildSha: null,
    approvedBuildSha: null,
    startedAt,
    status: 'RUNNING',
    readiness: 'HUMAN_REVIEW_PENDING',
    sessions: [],
    runDir: path.relative(process.cwd(), runDir).replace(/\\/gu, '/')
  };

  try {
    browser = await chromium.launch({ headless: false, executablePath: await resolveBrowserExecutable() });
    for (let sessionIndex = 0; sessionIndex < options.sessions; sessionIndex += 1) {
      const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
      await page.goto(options.siteUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      const { frame, input } = await chooseWidgetFrame(page);
      const apiBase = deriveApiBase(page, options.apiBase, options.siteUrl);
      run.apiBase = apiBase;

      let buildSha;
      if (options.target === 'production') {
        await assertProductionRuntimeMarker(apiBase);
        await requireProductionOpenAiRuntimeReady({
          productionApiBase: apiBase,
          requiredRemainingTokens: Math.max(120_000, options.maxTurns * 55_000)
        });
        const health = await fetchHealth(apiBase);
        buildSha = health.runtime.commitSha ?? null;
      } else {
        const preview = await assertPreviewBuild(apiBase);
        run.approvedBuildSha = preview.approvedSha;
        buildSha = preview.actualSha;
      }
      if (run.buildSha && buildSha && run.buildSha !== buildSha) {
        throw new Error('deployment_changed_between_buyer_sessions');
      }
      run.buildSha = buildSha;

      const session = await captureSession({
        page,
        frame,
        input,
        sessionIndex,
        options,
        apiBase,
        runDir
      });
      session.sessionIndex = sessionIndex + 1;
      run.sessions.push(session);
      await page.close();
      await assertBuildUnchanged(apiBase, buildSha);
      if (session.readiness === 'BLOCKED') break;
    }
    run.status = run.sessions.every((session) => session.readiness === 'HUMAN_REVIEW_PENDING')
      ? 'RUN_COMPLETE'
      : 'INCOMPLETE';
  } catch (error) {
    run.status = 'BLOCKED';
    run.failure = safeError(error);
  } finally {
    await browser?.close().catch(() => undefined);
    run.readiness = run.status === 'RUN_COMPLETE' ? 'HUMAN_REVIEW_PENDING' : 'BLOCKED';
    const artifacts = await writeRunArtifacts(run);
    console.log(JSON.stringify({
      status: run.status,
      readiness: run.readiness,
      target: run.target,
      sessionsCompleted: run.sessions.length,
      report: artifacts.markdownPath,
      evidence: artifacts.jsonPath,
      failure: run.failure ?? null
    }, null, 2));
  }
  return run.status;
}

export async function main(args = process.argv.slice(2)) {
  dotenv.config({ quiet: true });
  let options;
  try {
    options = codexCommandArguments(args);
  } catch (error) {
    console.error(safeError(error));
    return 2;
  }
  if (options.showHelp) {
    console.log(helpText());
    return 0;
  }
  try {
    options = validateOptions(options);
  } catch (error) {
    console.error(safeError(error));
    return 2;
  }
  if (options.dryRun) {
    printDryRun(options);
    return 0;
  }
  try {
    const status = await runLive(options);
    return status === 'RUN_COMPLETE' ? 0 : 2;
  } catch (error) {
    console.error(JSON.stringify({ status: 'BLOCKED', reason: safeError(error) }, null, 2));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((exitCode) => { process.exitCode = exitCode; });
}
