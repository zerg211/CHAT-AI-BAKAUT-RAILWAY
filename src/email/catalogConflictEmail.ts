import { fetch as defaultFetch } from 'undici';
import { config as runtimeConfig } from '../config.js';
import type { ProductAttributeConflict } from '../ai/productAttributeExtraction.js';
import type { ProductFactResolution } from '../ai/productFactResolution.js';
import type { Product } from '../shared/types.js';
import type { EmailResult } from './httpEmail.js';

export type CatalogConflictCustomerAction =
  | 'used_corrected_value'
  | 'blocked_from_recommendation'
  | 'escalated_for_manual_check';

export interface CatalogConflictEmailInput {
  product: Product;
  conflict: ProductAttributeConflict;
  resolution: ProductFactResolution;
  customerAction: CatalogConflictCustomerAction;
}

export interface CatalogConflictEmailPayload {
  subject: string;
  text: string;
}

interface EmailRuntimeConfig {
  EMAIL_HTTP_URL?: string;
  EMAIL_HTTP_METHOD: 'POST' | 'PUT';
  EMAIL_HTTP_AUTH_HEADER?: string;
  EMAIL_HTTP_TIMEOUT_MS: number;
  EMAIL_FROM?: string;
  LEADS_TO_EMAIL?: string;
}

interface SendCatalogConflictEmailOptions {
  fetchImpl?: typeof defaultFetch;
  config?: EmailRuntimeConfig;
}

function parseRecipients(value?: string) {
  return (value ?? '')
    .split(',')
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

function formatValue(value: unknown, attribute?: string) {
  if (value === undefined || value === null || value === '') return 'не указано';
  if (typeof value === 'number' && attribute === 'weightKg') return `${value} кг`;
  if (typeof value === 'number' && attribute === 'centrifugalForceKn') return `${value} кН`;
  if (typeof value === 'number' && attribute === 'voltageV') return `${value} В`;
  if (typeof value === 'number' && attribute === 'powerKw') return `${value} кВт`;
  return String(value);
}

function actionText(action: CatalogConflictCustomerAction) {
  switch (action) {
    case 'used_corrected_value':
      return 'Клиенту показано исправленное значение. Подбор выполнен по проверенной информации.';
    case 'blocked_from_recommendation':
      return 'Товар не показан клиенту как подходящий, потому что конфликт не был надежно подтвержден.';
    case 'escalated_for_manual_check':
      return 'Клиенту не выдавалась спорная характеристика как факт. Требуется ручная проверка карточки.';
  }
}

function productLink(product: Product, conflict: ProductAttributeConflict) {
  return product.sourceUrl || conflict.productUrl || product.slug || product.id;
}

function formatSourceLines(resolution: ProductFactResolution) {
  if (!resolution.sources.length) return ['Источники: не найдены / недостаточно данных'];
  return [
    'Источники:',
    ...resolution.sources.slice(0, 5).map((source, index) =>
      `${index + 1}. ${source.url} — ${source.title || source.sourceType}; подтверждает: ${formatValue(source.value, source.attribute)}; фрагмент: ${source.evidence}`
    )
  ];
}

export function buildCatalogConflictEmail(input: CatalogConflictEmailInput): CatalogConflictEmailPayload {
  const { product, conflict, resolution } = input;
  const confirmedValue = resolution.confirmedValue ?? 'не подтверждено';
  const subject = `Конфликт данных в карточке товара: ${product.name}`;
  const lines = [
    'Найден конфликт данных в карточке товара',
    '',
    `Товар: ${product.name}`,
    `Ссылка: ${productLink(product, conflict)}`,
    `ID: ${product.id}`,
    '',
    'Конфликт:',
    `- Характеристика: ${conflict.attribute}`,
    `- Название: ${conflict.nameRaw || formatValue(conflict.nameValue, conflict.attribute)}`,
    `- Характеристики: ${conflict.specsRaw || formatValue(conflict.specsValue, conflict.attribute)}`,
    '',
    `Проверенное значение: ${formatValue(confirmedValue, conflict.attribute)}`,
    `Статус проверки: ${resolution.status}`,
    `Пояснение: ${resolution.rationale}`,
    '',
    ...formatSourceLines(resolution),
    '',
    `Действие бота: ${actionText(input.customerAction)}`
  ];

  return { subject, text: lines.join('\n') };
}

function isResendEndpoint(url: string) {
  try {
    const target = new URL(url);
    let pathnameEnd = target.pathname.length;
    while (pathnameEnd > 0 && target.pathname[pathnameEnd - 1] === '/') pathnameEnd -= 1;
    return target.hostname === 'api.resend.com' && target.pathname.slice(0, pathnameEnd) === '/emails';
  } catch {
    return false;
  }
}

export async function sendCatalogConflictEmail(
  input: CatalogConflictEmailInput,
  options: SendCatalogConflictEmailOptions = {}
): Promise<EmailResult> {
  const cfg = options.config ?? runtimeConfig;
  if (!cfg.EMAIL_HTTP_URL) return { ok: false, skipped: true, error: 'EMAIL_HTTP_URL is not configured' };

  const from = cfg.EMAIL_FROM;
  const recipients = parseRecipients(cfg.LEADS_TO_EMAIL);
  if (!from || !recipients.length) return { ok: false, error: 'EMAIL_FROM and LEADS_TO_EMAIL are required' };

  const { subject, text } = buildCatalogConflictEmail(input);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.EMAIL_HTTP_AUTH_HEADER) {
    const [name, ...valueParts] = cfg.EMAIL_HTTP_AUTH_HEADER.split(':');
    if (name && valueParts.length) headers[name.trim()] = valueParts.join(':').trim();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.EMAIL_HTTP_TIMEOUT_MS);
  const body = isResendEndpoint(cfg.EMAIL_HTTP_URL)
    ? { from, to: recipients, subject, text }
    : { from, to: recipients.join(', '), subject, text, catalogConflict: input };

  try {
    const fetchImpl = options.fetchImpl ?? defaultFetch;
    const response = await fetchImpl(cfg.EMAIL_HTTP_URL, {
      method: cfg.EMAIL_HTTP_METHOD,
      headers,
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    const responseText = await response.text();
    let parsed: unknown = responseText;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      // Provider can return plain text.
    }
    return { ok: response.ok, status: response.status, response: parsed };
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
