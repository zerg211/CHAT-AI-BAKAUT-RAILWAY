import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AssistantFeedbackQueueItemSchema,
  buildAssistantFeedbackRegressionCandidate,
  knownPiiValuesForFeedback,
  type AssistantFeedbackRegressionFixture
} from '../ai/assistantFeedbackQueue.js';
import { pool } from '../db/pool.js';
import { ConversationRepository } from '../db/repositories.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const PRIVATE_EXPORT_ROOT = path.resolve('.private');

export const assistantFeedbackExportUsage = [
  'Usage: npx tsx src/scripts/exportAssistantFeedbackEvals.ts --output .private/<file.json> --acknowledge-unverified-residual-pii [--limit <1..1000>]',
  'Writes a UTF-8 JSON envelope containing PII-reduced candidate regression fixtures.',
  'Redaction is best-effort. The explicit acknowledgement is required because residual names, addresses, and social handles can remain.',
  'Output is restricted to the git-ignored .private directory. Review every fixture before manually promoting it into an eval.',
  'Only pending/in_review negative/wrong_cards events are eligible.'
].join('\n');

export interface ExportAssistantFeedbackArgs {
  output: string;
  limit: number;
  help: boolean;
  acknowledgeUnverifiedResidualPii: boolean;
}

export interface AssistantFeedbackExportRepository {
  listAssistantFeedbackQueue(input: {
    statuses: Array<'pending' | 'in_review'>;
    ratings: Array<'negative' | 'wrong_cards'>;
    limit: number;
  }): Promise<unknown[]>;
  markAssistantFeedbackExported(input: {
    exportedAt: string;
    items: Array<{
      eventId: string;
      fixture: AssistantFeedbackRegressionFixture;
    }>;
  }): Promise<unknown>;
}

export interface AssistantFeedbackExportEnvelope {
  schemaVersion: 'assistant-feedback-regression-export-v2';
  exportedAt: string;
  fixtureCount: number;
  fixtures: AssistantFeedbackRegressionFixture[];
}

export interface AssistantFeedbackExportDependencies {
  repository: AssistantFeedbackExportRepository;
  writeOutput: (outputPath: string, content: string) => Promise<void>;
  now?: () => Date;
}

export interface AssistantFeedbackCliDependencies {
  createRepository: () => AssistantFeedbackExportRepository;
  writeOutput: (outputPath: string, content: string) => Promise<void>;
  closePool: () => Promise<void>;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  now?: () => Date;
}

export class AssistantFeedbackExportCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AssistantFeedbackExportCliError';
  }
}

function isAsciiDigit(value: string) {
  const code = value.codePointAt(0) ?? 0;
  return code >= 48 && code <= 57;
}

function parseLimit(value: string) {
  if (!value || [...value].some((character) => !isAsciiDigit(character))) {
    throw new AssistantFeedbackExportCliError('invalid_limit');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new AssistantFeedbackExportCliError('invalid_limit');
  }
  return parsed;
}

function optionValue(argument: string, optionName: string) {
  const prefix = `${optionName}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : null;
}

export function parseExportAssistantFeedbackArgs(argv: string[]): ExportAssistantFeedbackArgs {
  let output: string | undefined;
  let limit = DEFAULT_LIMIT;
  let limitSeen = false;
  let help = false;
  let acknowledgeUnverifiedResidualPii = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }

    if (argument === '--acknowledge-unverified-residual-pii') {
      if (acknowledgeUnverifiedResidualPii) {
        throw new AssistantFeedbackExportCliError('duplicate_residual_pii_acknowledgement');
      }
      acknowledgeUnverifiedResidualPii = true;
      continue;
    }

    const inlineOutput = optionValue(argument, '--output');
    if (argument === '--output' || inlineOutput !== null) {
      if (output !== undefined) throw new AssistantFeedbackExportCliError('duplicate_output');
      const candidate = inlineOutput ?? argv[index + 1];
      if (inlineOutput === null) index += 1;
      if (!candidate || candidate.startsWith('--') || candidate.includes('\0')) {
        throw new AssistantFeedbackExportCliError('invalid_output');
      }
      output = candidate;
      continue;
    }

    const inlineLimit = optionValue(argument, '--limit');
    if (argument === '--limit' || inlineLimit !== null) {
      if (limitSeen) throw new AssistantFeedbackExportCliError('duplicate_limit');
      const candidate = inlineLimit ?? argv[index + 1];
      if (inlineLimit === null) index += 1;
      if (!candidate || candidate.startsWith('--')) {
        throw new AssistantFeedbackExportCliError('invalid_limit');
      }
      limit = parseLimit(candidate);
      limitSeen = true;
      continue;
    }

    throw new AssistantFeedbackExportCliError('unknown_argument');
  }

  if (!help && !output) throw new AssistantFeedbackExportCliError('missing_output');
  if (!help && !acknowledgeUnverifiedResidualPii) {
    throw new AssistantFeedbackExportCliError('missing_residual_pii_acknowledgement');
  }
  return { output: output ?? '', limit, help, acknowledgeUnverifiedResidualPii };
}

function isEligibleQueueItem(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const eligibleStatus = item.status === 'pending' || item.status === 'in_review';
  const eligibleRating = item.rating === 'negative' || item.rating === 'wrong_cards';
  return eligibleStatus && eligibleRating;
}

export async function writeAssistantFeedbackExportFile(outputPath: string, content: string) {
  const resolvedPath = resolvePrivateFeedbackExportPath(outputPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, content, 'utf8');
}

export function resolvePrivateFeedbackExportPath(outputPath: string) {
  const resolvedPath = path.resolve(outputPath);
  const relative = path.relative(PRIVATE_EXPORT_ROOT, resolvedPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AssistantFeedbackExportCliError('output_must_be_inside_private_directory');
  }
  return resolvedPath;
}

export async function runAssistantFeedbackExport(
  args: Pick<ExportAssistantFeedbackArgs, 'output' | 'limit' | 'acknowledgeUnverifiedResidualPii'>,
  dependencies: AssistantFeedbackExportDependencies
) {
  if (!args.acknowledgeUnverifiedResidualPii) {
    throw new AssistantFeedbackExportCliError('missing_residual_pii_acknowledgement');
  }
  resolvePrivateFeedbackExportPath(args.output);
  const exportedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const rows = await dependencies.repository.listAssistantFeedbackQueue({
    statuses: ['pending', 'in_review'],
    ratings: ['negative', 'wrong_cards'],
    limit: args.limit
  });
  const items = rows
    .filter(isEligibleQueueItem)
    .slice(0, args.limit)
    .map((row) => AssistantFeedbackQueueItemSchema.parse(row));
  const fixtures = items.map((item) => buildAssistantFeedbackRegressionCandidate(item, {
    knownPiiValues: knownPiiValuesForFeedback(item)
  }));
  const envelope: AssistantFeedbackExportEnvelope = {
    schemaVersion: 'assistant-feedback-regression-export-v2',
    exportedAt,
    fixtureCount: fixtures.length,
    fixtures
  };

  await dependencies.writeOutput(args.output, `${JSON.stringify(envelope, null, 2)}\n`);
  if (items.length) {
    await dependencies.repository.markAssistantFeedbackExported({
      exportedAt,
      items: items.map((item, index) => ({
        eventId: item.id,
        fixture: fixtures[index]
      }))
    });
  }

  return { fixtureCount: fixtures.length };
}

export async function executeAssistantFeedbackExportCli(
  argv: string[],
  dependencies: AssistantFeedbackCliDependencies
) {
  let exitCode = 0;
  try {
    const args = parseExportAssistantFeedbackArgs(argv);
    if (args.help) {
      dependencies.stdout(assistantFeedbackExportUsage);
    } else {
      const result = await runAssistantFeedbackExport(args, {
        repository: dependencies.createRepository(),
        writeOutput: dependencies.writeOutput,
        now: dependencies.now
      });
      dependencies.stdout(JSON.stringify({
        ok: true,
        format: 'json',
        fixtureCount: result.fixtureCount
      }));
    }
  } catch {
    dependencies.stderr('Assistant feedback export failed.');
    exitCode = 1;
  } finally {
    try {
      await dependencies.closePool();
    } catch {
      dependencies.stderr('Assistant feedback export cleanup failed.');
      exitCode = 1;
    }
  }
  return exitCode;
}

function productionRepository() {
  return new ConversationRepository() as unknown as AssistantFeedbackExportRepository;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executeAssistantFeedbackExportCli(process.argv.slice(2), {
    createRepository: productionRepository,
    writeOutput: writeAssistantFeedbackExportFile,
    closePool: () => pool.end(),
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message)
  }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
