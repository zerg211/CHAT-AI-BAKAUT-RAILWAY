import { config } from '../config.js';
import type { Product } from '../shared/types.js';
import { createStructuredJsonResponse } from './openaiStructured.js';
import { textMatchesTargetName } from './modelTextMatching.js';

export type ElectricStartStatus = 'present' | 'absent' | 'unknown';

export interface ElectricStartResearchOutcome {
  productId: string;
  productName: string;
  status: ElectricStartStatus;
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
  sourceUrl?: string;
  sourceTitle?: string;
  warnings: string[];
}

function researchJsonFormat() {
  return {
    format: {
      type: 'json_schema' as const,
      name: 'generator_electric_start_research',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modelFound: { type: 'boolean' },
          status: { type: 'string', enum: ['present', 'absent', 'unknown'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          evidence: { type: 'string' },
          sourceUrl: { type: 'string' },
          sourceTitle: { type: 'string' }
        },
        required: ['modelFound', 'status', 'confidence', 'evidence']
      }
    }
  } as const;
}

function normalizeParsed(parsed: Record<string, unknown>) {
  const statusRaw = String(parsed.status ?? 'unknown');
  const status: ElectricStartStatus = statusRaw === 'present' || statusRaw === 'absent'
    ? statusRaw
    : 'unknown';
  const confidenceRaw = String(parsed.confidence ?? 'low');
  const confidence = confidenceRaw === 'high' || confidenceRaw === 'medium'
    ? confidenceRaw
    : 'low';
  return {
    modelFound: parsed.modelFound === true,
    status,
    confidence,
    evidence: typeof parsed.evidence === 'string' ? parsed.evidence.trim() : '',
    sourceUrl: typeof parsed.sourceUrl === 'string' && /^https?:\/\//i.test(parsed.sourceUrl)
      ? parsed.sourceUrl
      : undefined,
    sourceTitle: typeof parsed.sourceTitle === 'string' ? parsed.sourceTitle.trim() : undefined
  };
}

export async function researchGeneratorElectricStart(input: {
  product: Product;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}): Promise<ElectricStartResearchOutcome> {
  const base: ElectricStartResearchOutcome = {
    productId: input.product.id,
    productName: input.product.name,
    status: 'unknown',
    confidence: 'low',
    evidence: '',
    warnings: []
  };
  const brand = input.product.brand?.trim() ?? '';
  const { parsed } = await createStructuredJsonResponse({
    request: {
      model: config.OPENAI_FACT_MODEL,
      reasoning: { effort: config.OPENAI_FACT_REASONING_EFFORT },
      tools: [{ type: 'web_search' }],
      input: [
        {
          role: 'system',
          content: [
            'You are an equipment fact researcher. Use ONLY web_search; do not answer from memory.',
            'Goal: determine whether this EXACT generator model has any electric starter (key, button, switch, or remote). Manual/recoil-only means "absent".',
            'Search the official manufacturer site, manuals, spec sheets, and reputable dealer pages. Match the exact model code; a different model in the same family does not count.',
            'If sources conflict or only vague marketing text exists, use status="unknown" and low confidence.',
            'evidence must contain a short verbatim quote from the source that proves the starter type.',
            'Return JSON only.'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            brand,
            model: input.product.name,
            article: input.product.specs?.['артикул'] ?? null,
            knownSpecs: Object.fromEntries(Object.entries(input.product.specs ?? {})
              .filter(([key]) => /стартер|запуск|аккумулятор|пуск/i.test(key)))
          })
        }
      ],
      max_output_tokens: Math.min(config.OPENAI_FACT_MAX_OUTPUT_TOKENS, 900),
      text: researchJsonFormat()
    },
    stage: 'electric_start_research',
    signal: input.signal,
    deadlineAtMs: input.deadlineAtMs,
    minRetryRemainingMs: 8_000,
    transportMaxRetries: 0
  });
  const normalized = normalizeParsed(parsed);
  if (!normalized.modelFound || !normalized.evidence) {
    return { ...base, warnings: [...base.warnings, 'research_model_not_confirmed'] };
  }
  // Guard against same-family/different-model substitution.
  const provenanceText = [normalized.sourceUrl, normalized.sourceTitle, normalized.evidence]
    .filter(Boolean)
    .join(' ');
  if (!textMatchesTargetName(provenanceText, input.product.name)) {
    return { ...base, warnings: [...base.warnings, 'research_exact_model_mismatch'] };
  }
  return {
    ...base,
    status: normalized.status,
    confidence: normalized.confidence,
    evidence: normalized.evidence.slice(0, 400),
    sourceUrl: normalized.sourceUrl,
    sourceTitle: normalized.sourceTitle
  };
}
