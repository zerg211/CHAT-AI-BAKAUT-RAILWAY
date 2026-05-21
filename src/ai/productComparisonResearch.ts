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
          'For web facts, fill sourceUrl/sourceTitle when the source is available.'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          buyerQuestion: input.userMessage,
          targetProductNames,
          comparisonAttributes: input.comparisonAttributes ?? [],
          products: productResearchContext(input.products)
        })
      }
    ],
    tools: [{ type: 'web_search_preview', search_context_size: 'medium' }],
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
