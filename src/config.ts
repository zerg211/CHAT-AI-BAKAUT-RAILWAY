import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const optionalSecret = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().min(8).optional()
);

const optionalString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().optional()
);

const optionalUrl = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().url().optional()
);

const optionalPositiveInt = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.coerce.number().int().positive().optional()
);

const defaultNonNegativeInt = (defaultValue: number) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.coerce.number().int().nonnegative().default(defaultValue)
);

const defaultPositiveInt = (defaultValue: number) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.coerce.number().int().positive().default(defaultValue)
);

const defaultUnitRatio = (defaultValue: number) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.coerce.number().gt(0).lte(1).default(defaultValue)
);

const emailHttpMethod = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.enum(['POST', 'PUT']).default('POST')
);

const reasoningEffort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function booleanFlag(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
    return value;
  }, z.boolean().default(defaultValue));
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3010),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3010'),
  WEB_DEV_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1).default('postgres://chat_ai:chat_ai@localhost:5432/chat_ai'),
  ADMIN_PASSWORD: optionalSecret,
  ADMIN_API_KEY: optionalSecret,
  MODEL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_ANSWER_MODEL: z.string().optional(),
  OPENAI_PLANNER_MODEL: z.string().optional(),
  OPENAI_FACT_MODEL: z.string().optional(),
  OPENAI_DEEP_REASONING_MODEL: z.string().optional(),
  OPENAI_REASONING_EFFORT: reasoningEffort.default('low'),
  OPENAI_ANSWER_REASONING_EFFORT: reasoningEffort.optional(),
  OPENAI_PLANNER_REASONING_EFFORT: reasoningEffort.optional(),
  OPENAI_FACT_REASONING_EFFORT: reasoningEffort.optional(),
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1200),  OPENAI_NEED_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8000),
  OPENAI_PLANNER_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(3200),
  OPENAI_FACT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(700),
  EMBEDDING_MIN_COVERAGE: z.coerce.number().min(0).max(1).default(0.05),
  DEBUG_OPENAI_USAGE: booleanFlag(false),
  OPENAI_USAGE_GUARD_ENABLED: booleanFlag(true),
  OPENAI_DAILY_TOKEN_BUDGET: defaultPositiveInt(6000000),
  OPENAI_BUDGET_GUARD_RESERVE_TOKENS: defaultNonNegativeInt(16000),
  OPENAI_ENABLE_WEB_FACT_EXTRACTION: booleanFlag(true),
  CATALOG_BASE_URL: z.string().url().default('https://bakautprof.ru'),
  CATALOG_MAX_PAGES: z.coerce.number().int().positive().default(300),
  CATALOG_REQUEST_TIMEOUT_MS: defaultPositiveInt(35_000),
  CATALOG_MAX_RESPONSE_BYTES: defaultPositiveInt(2 * 1024 * 1024),
  CATALOG_MAX_SITEMAP_BYTES: defaultPositiveInt(5 * 1024 * 1024),
  CATALOG_MAX_SITEMAP_FILES: defaultPositiveInt(100),
  CATALOG_MAX_SITEMAP_ENTRIES: defaultPositiveInt(100_000),
  CATALOG_DEACTIVATION_MIN_DISCOVERY_RATIO: defaultUnitRatio(0.8),
  CATALOG_DEACTIVATION_MIN_DISCOVERY_FLOOR: defaultNonNegativeInt(100),
  CATALOG_IMPORT_ROOT: z.string().trim().min(1).default('catalog-imports'),
  CATALOG_MAX_CSV_BYTES: defaultPositiveInt(25 * 1024 * 1024),
  CATALOG_MAX_CSV_ROWS: defaultPositiveInt(50_000),
  CATALOG_STALE_AFTER_HOURS: defaultPositiveInt(48),
  EMAIL_HTTP_URL: optionalUrl,
  EMAIL_HTTP_METHOD: emailHttpMethod,
  EMAIL_HTTP_AUTH_HEADER: optionalString,
  EMAIL_HTTP_TIMEOUT_MS: defaultPositiveInt(10000),
  EMAIL_FROM: optionalString,
  LEADS_TO_EMAIL: optionalString,
  RESEND_API_KEY: optionalSecret,
  RESEND_FROM: optionalString,
  RESEND_TIMEOUT_MS: optionalPositiveInt,
  LEAD_EMAIL_TO: optionalString,
  LEAD_EMAIL: optionalString,
  CORS_ORIGINS: optionalString
});

const parsedConfig = schema.parse(process.env);
const resendEmailUrl = parsedConfig.RESEND_API_KEY ? 'https://api.resend.com/emails' : undefined;
const resendAuthHeader = parsedConfig.RESEND_API_KEY ? `Authorization: Bearer ${parsedConfig.RESEND_API_KEY}` : undefined;
const requiredProductionManagerModel = 'gpt-5.6-luna';
const configuredPrimaryModel = parsedConfig.OPENAI_ANSWER_MODEL
  || parsedConfig.OPENAI_MODEL
  || parsedConfig.MODEL
  || requiredProductionManagerModel;
const primaryModel = parsedConfig.NODE_ENV === 'production'
  ? requiredProductionManagerModel
  : configuredPrimaryModel;
const deepReasoningModel = parsedConfig.NODE_ENV === 'production'
  ? requiredProductionManagerModel
  : parsedConfig.OPENAI_DEEP_REASONING_MODEL || requiredProductionManagerModel;
const plannerModel = parsedConfig.NODE_ENV === 'production'
  ? requiredProductionManagerModel
  : parsedConfig.OPENAI_PLANNER_MODEL || primaryModel;
const factModel = parsedConfig.NODE_ENV === 'production'
  ? requiredProductionManagerModel
  : parsedConfig.OPENAI_FACT_MODEL || plannerModel;
const normalizeReasoningEffort = (value: z.infer<typeof reasoningEffort>) =>
  value === 'minimal' ? 'none' : value;

export const config = {
  ...parsedConfig,
  EMAIL_HTTP_URL: parsedConfig.EMAIL_HTTP_URL || resendEmailUrl,
  EMAIL_HTTP_AUTH_HEADER: parsedConfig.EMAIL_HTTP_AUTH_HEADER || resendAuthHeader,
  EMAIL_HTTP_TIMEOUT_MS: parsedConfig.RESEND_TIMEOUT_MS || parsedConfig.EMAIL_HTTP_TIMEOUT_MS,
  EMAIL_FROM: parsedConfig.EMAIL_FROM || parsedConfig.RESEND_FROM,
  LEADS_TO_EMAIL: parsedConfig.LEADS_TO_EMAIL || parsedConfig.LEAD_EMAIL_TO || parsedConfig.LEAD_EMAIL,
  OPENAI_MODEL: parsedConfig.NODE_ENV === 'production'
    ? requiredProductionManagerModel
    : parsedConfig.OPENAI_MODEL || primaryModel,
  OPENAI_ANSWER_MODEL: primaryModel,
  OPENAI_PLANNER_MODEL: plannerModel,
  OPENAI_FACT_MODEL: factModel,
  OPENAI_DEEP_REASONING_MODEL: deepReasoningModel,
  OPENAI_ANSWER_REASONING_EFFORT: parsedConfig.NODE_ENV === 'production'
    ? 'high' as const
    : normalizeReasoningEffort(parsedConfig.OPENAI_ANSWER_REASONING_EFFORT || parsedConfig.OPENAI_REASONING_EFFORT),
  // Writer reasoning tokens count against max_output_tokens; at high effort the
  // reasoning alone can exceed the old 1200 default and truncate the answer JSON.
  OPENAI_WRITER_MAX_OUTPUT_TOKENS: parsedConfig.NODE_ENV === 'production'
    ? 4000
    : parsedConfig.OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_PLANNER_REASONING_EFFORT: parsedConfig.NODE_ENV === 'production'
    // Planning quality comes from the 50-rule typed contract prompt; xhigh there cost
    // 36-61s per decision and truncated whole turns. High keeps the contract quality
    // at a third of the time.
    ? 'high' as const
    : normalizeReasoningEffort(parsedConfig.OPENAI_PLANNER_REASONING_EFFORT || parsedConfig.OPENAI_REASONING_EFFORT),
  OPENAI_PLANNER_MAX_OUTPUT_TOKENS: parsedConfig.NODE_ENV === 'production'
    ? 9000
    : parsedConfig.OPENAI_PLANNER_MAX_OUTPUT_TOKENS,
  OPENAI_FACT_REASONING_EFFORT: parsedConfig.NODE_ENV === 'production'
    ? 'xhigh' as const
    : normalizeReasoningEffort(parsedConfig.OPENAI_FACT_REASONING_EFFORT || 'none'),
  // Repair rewrites wording after a failed fact-check, not deep reasoning: high keeps
  // it fast enough to fit the turn budget after a full xhigh writer pass.
  OPENAI_REPAIR_REASONING_EFFORT: parsedConfig.NODE_ENV === 'production'
    ? 'high' as const
    : normalizeReasoningEffort(parsedConfig.OPENAI_ANSWER_REASONING_EFFORT || parsedConfig.OPENAI_REASONING_EFFORT)
};

export type AppConfig = typeof config;
