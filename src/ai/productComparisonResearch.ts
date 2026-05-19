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
  signal?: AbortSignal;
}): Promise<ProductComparisonResearchResult> {
  if (input.products.length < 2) {
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
          'Не пиши ответ покупателю. Верни только JSON.'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          buyerQuestion: input.userMessage,
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
                  evidence: { type: 'string' }
                },
                required: ['productName', 'attribute', 'value', 'sourceType', 'confidence', 'evidence']
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
                  catalogValue: { type: 'string' },
                  webValues: { type: 'array', items: { type: 'string' } },
                  resolution: { type: 'string' }
                },
                required: ['productName', 'attribute', 'webValues', 'resolution']
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

  const { parsed } = await createStructuredJsonResponse({
    request,
    stage: 'product_comparison_research',
    signal: input.signal
  });

  return {
    usedWebSearch: parsed.usedWebSearch === true,
    facts: Array.isArray(parsed.facts) ? parsed.facts as ProductComparisonResearchFact[] : [],
    conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts as ProductComparisonResearchConflict[] : [],
    summaryForAnswer: typeof parsed.summaryForAnswer === 'string' ? parsed.summaryForAnswer : '',
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((item): item is string => typeof item === 'string') : []
  };
}
