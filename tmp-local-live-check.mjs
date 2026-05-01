import { chromium } from 'playwright';

const url = process.env.BAKAUT_UI_URL || 'http://127.0.0.1:5173/';
const turns = [
  'Нужен генератор для дачи. Будут свет, холодильник, иногда дрель или болгарка, мощность инструмента не знаю. Сеть 220 В.',
  'Не хочу долго выбирать. Выдели один основной вариант и один запасной.',
  'А какой из этих двух разумнее брать первым и почему?',
  'Если добавятся роутер, телевизор и ноутбук, это меняет выбор? Чайник и инструмент одновременно включать не буду.',
  'По шуму и качеству напряжения какой из текущих вариантов безопаснее для холодильника и ноутбука?',
  'А если смотреть дешевле при тех же нагрузках, есть смысл заменить основной вариант?',
  'Тогда сравни новый дешевый вариант с тем, который был основным: где компромисс?',
  'Хочу чтобы специалист подтвердил наличие и цену. Меня зовут Иван, телефон +7 900 111-22-33.'
];

function compact(text) { return String(text || '').replace(/\s+/g, ' ').trim(); }

async function waitForFinalAnswer(page, prevCount) {
  await page.waitForFunction((count) => {
    const nodes = Array.from(document.querySelectorAll('.message.assistant, .assistant-message, [data-role="assistant"]'));
    const last = nodes[nodes.length - 1]?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return nodes.length > count &&
      last.length > 50 &&
      !/Проверяю каталог|Собираю короткий ответ|\.\.\.$/.test(last) &&
      !document.querySelector('form.composer .stop-button') &&
      !document.querySelector('form.composer textarea[disabled]');
  }, prevCount, { timeout: 180000 });
  await page.waitForTimeout(700);
}

async function send(page, text) {
  const before = await page.locator('.message.assistant, .assistant-message, [data-role="assistant"]').count();
  await page.getByPlaceholder('Например: нужен генератор для дачи на 5 кВт').fill(text);
  await page.getByRole('button', { name: /^Отправить$|^\.\.\.$/ }).click();
  await waitForFinalAnswer(page, before);
  const last = page.locator('.message.assistant, .assistant-message, [data-role="assistant"]').last();
  return {
    user: text,
    assistant: compact(await last.innerText()),
    cardCount: await last.locator('.product-card').count(),
    cards: await last.locator('.product-card').evaluateAll((cards) => cards.map((c) => c.textContent?.replace(/\s+/g, ' ').trim() || '')),
    moreButtons: await last.locator('button.product-more').evaluateAll((buttons) => buttons.map((b) => b.textContent?.trim() || ''))
  };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1365, height: 950 } });
const consoleMessages = [];
page.on('console', (msg) => { if (['error', 'warning'].includes(msg.type())) consoleMessages.push(`${msg.type()}: ${msg.text()}`); });
page.on('pageerror', (err) => consoleMessages.push(`pageerror: ${err.message}`));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.getByPlaceholder('Например: нужен генератор для дачи на 5 кВт').waitFor({ timeout: 30000 });

const log = [];
for (const turn of turns) log.push(await send(page, turn));

const body = compact(await page.locator('body').innerText());
const impossibleRanges = Array.from(body.matchAll(/(?:от\s*)?(\d+[,.]?\d*)\s*(?:-|–|—|до)\s*(\d+[,.]?\d*)\s*кВт/gi))
  .map((m) => [Number(m[1].replace(',', '.')), Number(m[2].replace(',', '.')), m[0]])
  .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a > b);
const narrowTurn = log[1];
const followupTurn = log[2];
const nonSimTurn = log[3];
const cheaperTurn = log[5];
const finalTurn = log[7];
const result = {
  ok: true,
  checks: {
    url,
    turns: log.length,
    narrowCardsLatestTurn: narrowTurn.cardCount,
    currentFollowupCardsLatestTurn: followupTurn.cardCount,
    currentFollowupOpenedBroadSearch: /ПОДХОДЯЩИЕ ВАРИАНТЫ\s+(?:[3-9]|\d{2,})/i.test(followupTurn.assistant),
    nonSimInflatedTo75kw: /7[,.]5\s*кВт|7[,.]3\s*кВт/i.test(nonSimTurn.assistant),
    explicitCheaperAllowedNewSearch: /дешев|замен|компромисс|ПОДХОДЯЩИЕ ВАРИАНТЫ/i.test(cheaperTurn.assistant),
    impossibleRanges,
    leadSavedOrHandoff: /заявка сохранена|передаю запрос|специалист|свяжется/i.test(finalTurn.assistant + ' ' + body),
    consoleErrors: consoleMessages.filter((line) => !/Download the React DevTools/i.test(line)),
    totalProductCardsInHistory: await page.locator('.product-card').count(),
    allMoreButtons: await page.locator('button.product-more').evaluateAll((buttons) => buttons.map((b) => b.textContent?.trim() || ''))
  },
  log: log.map((turn, index) => ({
    turn: index + 1,
    user: turn.user,
    answerPreview: turn.assistant.slice(0, 500),
    cardCount: turn.cardCount,
    moreButtons: turn.moreButtons,
    cards: turn.cards.slice(0, 3)
  }))
};
result.ok = result.checks.turns === turns.length &&
  result.checks.narrowCardsLatestTurn === 2 &&
  !result.checks.currentFollowupOpenedBroadSearch &&
  !result.checks.nonSimInflatedTo75kw &&
  result.checks.explicitCheaperAllowedNewSearch &&
  result.checks.impossibleRanges.length === 0 &&
  result.checks.leadSavedOrHandoff &&
  result.checks.consoleErrors.length === 0;
console.log(JSON.stringify(result, null, 2));
await browser.close();
if (!result.ok) process.exit(1);
