import { config } from '../config.js';
import type { Product } from '../shared/types.js';
import { createStructuredJsonResponse } from './openaiStructured.js';

export interface ProductComparisonResearchFact {
  productName: string;
  attribute: string;
  value: string;
  sourceType: 'catalog' | 'web' | 'conflict';
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

export interface ProductComparisonResearchConflict {
  productName: string;
  attribute: string;
  catalogValue?: string;
  webValues: string[];
  resolution: string;
}

export interface ProductComparisonResearchResult {
  usedWebSearch: boolean;
  facts: ProductComparisonResearchFact[];
  conflicts: ProductComparisonResearchConflict[];
  summaryForAnswer: string;
  warnings: string[];
}

function productResearchContext(products: Product[]) {
  return products.map((product) => ({
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    price: product.price,
    currency: product.currency,
    sourceUrl: product.sourceUrl,
    specs: product.specs,
    description: product.description
  }));
}

function exactTargetSearchQueries(targetProductNames: string[], attributes: string[]) {
  const usefulAttributes = attributes.length
    ? attributes
    : ['specification', 'manual', 'starter', 'start method'];
  const defaultAttributes = [
    'specification',
    'manual pdf',
    'instruction',
    'ignition key',
    'key start',
    'push button start',
    'electric starter',
    'recoil starter',
    'ключ зажигания',
    'кнопка запуска',
    'электростартер',
    'ручной стартер'
  ];
  return targetProductNames.flatMap((target) => {
    const aliases = exactTargetAliases(target);
    const queryAttributes = uniqueStrings([...usefulAttributes, ...defaultAttributes]).slice(0, 14);
    return aliases.flatMap((alias) => queryAttributes.map((attribute) => `${alias} ${attribute}`));
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function exactTargetAliases(target: string) {
  const tokens = exactTargetTokens(target);
  const modelTokens = tokens.filter((token) => tokenHasDigit(token) && tokenHasLetter(token));
  return uniqueStrings([
    `"${target}"`,
    target,
    ...modelTokens,
    ...modelTokens.map((token) => `"${token}"`)
  ]);
}

function charCode(char: string) {
  return char.codePointAt(0) ?? 0;
}

function isAsciiDigit(char: string) {
  const code = charCode(char);
  return code >= 48 && code <= 57;
}

function isAsciiLetter(char: string) {
  const code = charCode(char);
  return code >= 97 && code <= 122;
}

function isCyrillicLetter(char: string) {
  const code = charCode(char);
  return (code >= 0x0430 && code <= 0x044f) || code === 0x0451;
}

function isExactTargetTokenChar(char: string) {
  return isAsciiDigit(char) || isAsciiLetter(char) || isCyrillicLetter(char);
}

function tokenHasDigit(token: string) {
  for (const char of token) {
    if (isAsciiDigit(char)) return true;
  }
  return false;
}

function tokenHasLetter(token: string) {
  for (const char of token) {
    if (isAsciiLetter(char) || isCyrillicLetter(char)) return true;
  }
  return false;
}

function exactTargetTokens(value: unknown) {
  const tokens: string[] = [];
  let current = '';
  for (const char of String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU')) {
    if (isExactTargetTokenChar(char)) {
      current += char;
    } else if (current) {
      tokens.push(current);
      current = '';
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function compactExactTargetText(value: unknown) {
  let compact = '';
  for (const char of String(value ?? '').normalize('NFKD').toLocaleLowerCase('ru-RU')) {
    if (isExactTargetTokenChar(char)) compact += char;
  }
  return compact;
}

function factValueIsNegative(value: string) {
  const normalized = value.toLocaleLowerCase('ru-RU');
  return [
    'not confirmed',
    'not found',
    'не найден',
    'не подтвержден',
    'не подтвержд'
  ].some((phrase) => normalized.includes(phrase));
}

function factMatchesTarget(fact: ProductComparisonResearchFact, targetName: string) {
  const factText = compactExactTargetText([fact.productName, fact.sourceUrl, fact.sourceTitle, fact.evidence].filter(Boolean).join(' '));
  const targetText = compactExactTargetText(targetName);
  const targetTokens = exactTargetAliases(targetName)
    .map(compactExactTargetText)
    .filter((token) => token.length >= 4 && tokenHasDigit(token));
  if (targetTokens.length) return targetTokens.some((token) => factText.includes(token));
  return targetText.length >= 5 && factText.includes(targetText);
}

function hasConfirmedExactTargetFacts(result: ProductComparisonResearchResult, targetProductNames: string[]) {
  return result.facts.some((fact) =>
    fact.sourceType === 'web' &&
    ['high', 'medium'].includes(fact.confidence) &&
    targetProductNames.some((targetName) => factMatchesTarget(fact, targetName)) &&
    !factValueIsNegative(fact.value)
  );
}

function normalizeResearchParsed(parsed: Record<string, unknown>): ProductComparisonResearchResult {
  return {
    usedWebSearch: parsed.usedWebSearch === true,
    facts: Array.isArray(parsed.facts)
      ? (parsed.facts as Array<ProductComparisonResearchFact & { sourceUrl?: string | null; sourceTitle?: string | null }>).map((fact) => ({
          ...fact,
          sourceUrl: typeof fact.sourceUrl === 'string' ? fact.sourceUrl : undefined,
          sourceTitle: typeof fact.sourceTitle === 'string' ? fact.sourceTitle : undefined
        }))
      : [],
    conflicts: Array.isArray(parsed.conflicts)
      ? (parsed.conflicts as Array<ProductComparisonResearchConflict & { catalogValue?: string | null }>).map((conflict) => ({
          ...conflict,
          catalogValue: typeof conflict.catalogValue === 'string' ? conflict.catalogValue : undefined
        }))
      : [],
    summaryForAnswer: typeof parsed.summaryForAnswer === 'string' ? parsed.summaryForAnswer : '',
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === 'string') : []
  };
}

export async function researchProductComparisonFacts(input: {
  userMessage: string;
  products: Product[];
  targetProductNames?: string[];
  comparisonAttributes?: string[];
  signal?: AbortSignal;
}): Promise<ProductComparisonResearchResult> {
  const targetProductNames = (input.targetProductNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const comparisonAttributes = (input.comparisonAttributes ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  if (input.products.length < 2 && !targetProductNames.length) {
    return {
      usedWebSearch: false,
      facts: [],
      conflicts: [],
      summaryForAnswer: 'Недостаточно товаров для сравнения.',
      warnings: ['not_enough_products_for_comparison']
    };
  }

  const request: Record<string, unknown> = {
    model: config.OPENAI_FACT_MODEL,
    input: [
      {
        role: 'system',
        content: [
          'Ты внутренний research-модуль AI менеджера БАКАУТ.',
          'Сравнивай товары только по проверенным фактам.',
          'Каталог является первым источником. Если важного факта нет или есть конфликт, используй web search.',
          'Если web и каталог конфликтуют по важному параметру, укажи конфликт и выбери значение только при подтверждении логикой источников.',
          'Не пиши ответ покупателю. Верни только JSON.',
          'If buyerQuestion asks about targetProductNames and the exact model is absent from products, search the web for that exact target model. Do not infer exact target facts from nearby models.',
          'When targetProductNames is present, search exact quoted target names on the public web with the requested attributes before using nearby catalog products.',
          'A web fact for a target model is valid only when sourceUrl, sourceTitle, or evidence names the same exact model identifier. Same brand, same family, or nearby model pages are not proof about the target model.',
          'Do not cite bakautprof.ru or provided product.sourceUrl pages as web facts for an absent exact target unless that page is specifically about the exact target model.',
          'If exact external sources state key start, ignition key, electric starter, push button, manual recoil, battery, power, engine, or other requested attributes for the target, return those facts with high or medium confidence.',
          'For binary buyer choices such as key vs push-button, manual vs electric, gasoline vs diesel, continue exact-target web search until each choice is confirmed, contradicted, or explicitly not found in exact-target sources. Do not stop at a broad fact like "electric starter" when the buyer asked about the more specific mechanism.',
          'Use nearby catalog products only as catalog alternatives/orientation in summaryForAnswer; never as the technical fact for an absent exact target.',
          'If exact target facts cannot be found externally, return no target fact and add warning exact_target_external_fact_not_found instead of returning nearby-model facts.',
          'For web facts, fill sourceUrl/sourceTitle when the source is available.'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          buyerQuestion: input.userMessage,
          targetProductNames,
          comparisonAttributes,
          exactTargetSearchQueries: exactTargetSearchQueries(targetProductNames, comparisonAttributes),
          products: productResearchContext(input.products)
        })
      }
    ],
    tools: [{ type: 'web_search_preview', search_context_size: targetProductNames.length ? 'high' : 'medium' }],
    max_output_tokens: config.OPENAI_FACT_MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: 'json_schema',
        name: 'product_comparison_research',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            usedWebSearch: { type: 'boolean' },
            facts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  productName: { type: 'string' },
                  attribute: { type: 'string' },
                  value: { type: 'string' },
                  sourceType: { type: 'string', enum: ['catalog', 'web', 'conflict'] },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                  evidence: { type: 'string' },
                  sourceUrl: { type: ['string', 'null'] },
                  sourceTitle: { type: ['string', 'null'] }
                },
                required: ['productName', 'attribute', 'value', 'sourceType', 'confidence', 'evidence', 'sourceUrl', 'sourceTitle']
              }
            },
            conflicts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  productName: { type: 'string' },
                  attribute: { type: 'string' },
                  catalogValue: { type: ['string', 'null'] },
                  webValues: { type: 'array', items: { type: 'string' } },
                  resolution: { type: 'string' }
                },
                required: ['productName', 'attribute', 'catalogValue', 'webValues', 'resolution']
              }
            },
            summaryForAnswer: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } }
          },
          required: ['usedWebSearch', 'facts', 'conflicts', 'summaryForAnswer', 'warnings']
        }
      }
    }
  };

  if (targetProductNames.length) {
    request.tool_choice = { type: 'web_search_preview' };
  }

  const { parsed } = await createStructuredJsonResponse({
    request,
    stage: 'product_comparison_research',
    signal: input.signal
  });
  const primaryResult = normalizeResearchParsed(parsed);

  if (targetProductNames.length && !hasConfirmedExactTargetFacts(primaryResult, targetProductNames)) {
    const retryRequest: Record<string, unknown> = {
      ...request,
      input: [
        {
          role: 'system',
          content: [
            'You are a second-pass exact-model web research module for a sales assistant.',
            'The first pass did not find a confirmed exact-target fact. Search again without catalog product context.',
            'Use exactTargetSearchQueries and search public web pages, official manufacturer pages, distributor pages, PDFs, manuals, and specification sheets that mention the exact model/code.',
            'Accept a fact only when sourceUrl, sourceTitle, or evidence names the exact target model/code.',
            'For key vs push-button questions, ignition keys in the kit or ignition-key wording supports key start; absence of push-button wording means push-button is not confirmed.',
            'Do not use nearby model pages as facts for the target. Return no fact if the exact target still cannot be verified.',
            'Return only JSON.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            buyerQuestion: input.userMessage,
            targetProductNames,
            comparisonAttributes,
            exactTargetSearchQueries: exactTargetSearchQueries(targetProductNames, comparisonAttributes)
          })
        }
      ],
      tools: [{ type: 'web_search_preview', search_context_size: 'high' }],
      tool_choice: { type: 'web_search_preview' }
    };
    const retry = await createStructuredJsonResponse({
      request: retryRequest,
      stage: 'product_comparison_research_exact_retry',
      signal: input.signal
    });
    const retryResult = normalizeResearchParsed(retry.parsed);
    if (hasConfirmedExactTargetFacts(retryResult, targetProductNames)) {
      return {
        usedWebSearch: primaryResult.usedWebSearch || retryResult.usedWebSearch,
        facts: retryResult.facts,
        conflicts: retryResult.conflicts.length ? retryResult.conflicts : primaryResult.conflicts,
        summaryForAnswer: retryResult.summaryForAnswer || primaryResult.summaryForAnswer,
        warnings: uniqueStrings([
          ...primaryResult.warnings.filter((warning) => warning !== 'exact_target_external_fact_not_found'),
          ...retryResult.warnings.filter((warning) => warning !== 'exact_target_external_fact_not_found'),
          'exact_target_external_retry_used'
        ])
      };
    }
  }

  return primaryResult;
}
