import { describe, expect, it, vi } from 'vitest';
import {
  AssistantFeedbackExportCliError,
  executeAssistantFeedbackExportCli,
  parseExportAssistantFeedbackArgs,
  runAssistantFeedbackExport,
  type AssistantFeedbackExportRepository
} from '../src/scripts/exportAssistantFeedbackEvals.js';

function queueItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    turnId: '33333333-3333-4333-8333-333333333333',
    userMessageId: '44444444-4444-4444-8444-444444444444',
    assistantMessageId: '55555555-5555-4555-8555-555555555555',
    rating: 'negative',
    status: 'pending',
    buyerMessage: 'Я Алексей, телефон +7 900 123-45-67. Нужен генератор.',
    assistantAnswer: 'Ответ для Алексея отправлю на buyer@example.test.',
    policyEvidence: {
      version: 'sales-manager-v3',
      hash: 'policy-hash',
      selectedRuleIds: ['grounding'],
      reviewMode: 'risk',
      reviewReason: 'feedback export'
    },
    modelEvidence: {
      plannerModel: 'gpt-5.4',
      answerModel: 'gpt-5.4',
      reviewerModel: null,
      responseIds: ['private-response-id']
    },
    toolEvidence: [{
      requestId: 'catalog-1',
      tool: 'catalog.search',
      status: 'ok',
      warnings: [],
      payload: { contact: { name: 'Алексей', phone: '+7 900 123-45-67' } }
    }],
    cardEvidence: [],
    diagnosticMetadata: { contact: { name: 'Алексей' }, visitorId: 'private-visitor' },
    feedbackCreatedAt: '2026-07-10T12:00:00.000Z',
    createdAt: '2026-07-10T12:00:01.000Z',
    updatedAt: '2026-07-10T12:00:01.000Z',
    ...overrides
  };
}

function fakeRepository(rows: unknown[]) {
  return {
    listAssistantFeedbackQueue: vi.fn(async () => rows),
    markAssistantFeedbackExported: vi.fn(async () => undefined)
  } satisfies AssistantFeedbackExportRepository;
}

describe('exportAssistantFeedbackEvals CLI', () => {
  it('parses split/inline options, documents JSON, and applies a bounded default limit', () => {
    expect(parseExportAssistantFeedbackArgs(['--output', '.private/fixtures.json', '--acknowledge-unverified-residual-pii'])).toEqual({
      output: '.private/fixtures.json',
      limit: 100,
      help: false,
      acknowledgeUnverifiedResidualPii: true
    });
    expect(parseExportAssistantFeedbackArgs(['--output=.private/fixtures.json', '--limit=25', '--acknowledge-unverified-residual-pii'])).toEqual({
      output: '.private/fixtures.json',
      limit: 25,
      help: false,
      acknowledgeUnverifiedResidualPii: true
    });
    expect(parseExportAssistantFeedbackArgs(['--help'])).toMatchObject({ help: true });
    for (const args of [
      [],
      ['--output'],
      ['--output', 'out.json'],
      ['--output', 'out.json', '--limit', '0'],
      ['--output', 'out.json', '--limit', '1001'],
      ['--output', 'out.json', '--limit', '1e2'],
      ['--unknown']
    ]) {
      expect(() => parseExportAssistantFeedbackArgs(args)).toThrow(AssistantFeedbackExportCliError);
    }
  });

  it('exports only eligible events, writes before marking, and emits no raw identifiers or contact values', async () => {
    const repository = fakeRepository([
      queueItem(),
      queueItem({
        id: '66666666-6666-4666-8666-666666666666',
        assistantMessageId: '77777777-7777-4777-8777-777777777777',
        rating: 'wrong_cards',
        status: 'in_review'
      }),
      queueItem({
        id: '88888888-8888-4888-8888-888888888888',
        assistantMessageId: '99999999-9999-4999-8999-999999999999',
        status: 'resolved'
      })
    ]);
    const order: string[] = [];
    const writeOutput = vi.fn(async (_path: string, _content: string) => {
      order.push('write');
    });
    repository.markAssistantFeedbackExported.mockImplementation(async () => {
      order.push('mark');
      return undefined;
    });

    const result = await runAssistantFeedbackExport({
      output: '.private/fixtures.json',
      limit: 10,
      acknowledgeUnverifiedResidualPii: true
    }, {
      repository,
      writeOutput,
      now: () => new Date('2026-07-10T13:00:00.000Z')
    });

    expect(result.fixtureCount).toBe(2);
    expect(repository.listAssistantFeedbackQueue).toHaveBeenCalledWith({
      statuses: ['pending', 'in_review'],
      ratings: ['negative', 'wrong_cards'],
      limit: 10
    });
    expect(order).toEqual(['write', 'mark']);
    const output = String(writeOutput.mock.calls[0][1]);
    const envelope = JSON.parse(output);
    expect(envelope).toMatchObject({
      schemaVersion: 'assistant-feedback-regression-export-v2',
      fixtureCount: 2
    });
    expect(envelope.fixtures[0].redaction).toMatchObject({
      residualPiiStatus: 'best_effort_redaction_not_verified',
      residualPiiReviewRequired: true
    });
    expect(output).not.toContain('22222222-2222-4222-8222-222222222222');
    expect(output).not.toContain('33333333-3333-4333-8333-333333333333');
    expect(output).not.toContain('55555555-5555-4555-8555-555555555555');
    expect(output).not.toContain('Алексей');
    expect(output).not.toContain('+7 900 123-45-67');
    expect(output).not.toContain('buyer@example.test');
    expect(output).not.toContain('private-response-id');
    expect(output).not.toContain('private-visitor');
    expect(repository.markAssistantFeedbackExported).toHaveBeenCalledWith(expect.objectContaining({
      exportedAt: '2026-07-10T13:00:00.000Z',
      items: expect.arrayContaining([
        expect.objectContaining({ eventId: '11111111-1111-4111-8111-111111111111' })
      ])
    }));
  });

  it('does not mark events when the JSON write fails', async () => {
    const repository = fakeRepository([queueItem()]);
    await expect(runAssistantFeedbackExport({
      output: '.private/fixtures.json',
      limit: 10,
      acknowledgeUnverifiedResidualPii: true
    }, {
      repository,
      writeOutput: async () => {
        throw new Error('write failed with buyer@example.test');
      }
    })).rejects.toThrow();
    expect(repository.markAssistantFeedbackExported).not.toHaveBeenCalled();
  });

  it('closes the pool and returns nonzero without logging a failure containing PII', async () => {
    const stderr = vi.fn();
    const stdout = vi.fn();
    const closePool = vi.fn(async () => undefined);
    const exitCode = await executeAssistantFeedbackExportCli([
      '--output',
      '.private/fixtures.json',
      '--acknowledge-unverified-residual-pii'
    ], {
      createRepository: () => fakeRepository([queueItem()]),
      writeOutput: async () => {
        throw new Error('buyer@example.test +7 900 123-45-67');
      },
      closePool,
      stdout,
      stderr
    });

    expect(exitCode).toBe(1);
    expect(closePool).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith('Assistant feedback export failed.');
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('buyer@example.test');
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('+7 900 123-45-67');
  });

  it('refuses to query or write export data without explicit residual-PII acknowledgement', async () => {
    const repository = fakeRepository([queueItem()]);
    const writeOutput = vi.fn(async () => undefined);

    await expect(runAssistantFeedbackExport({
      output: '.private/fixtures.json',
      limit: 10,
      acknowledgeUnverifiedResidualPii: false
    }, {
      repository,
      writeOutput
    })).rejects.toMatchObject({ code: 'missing_residual_pii_acknowledgement' });
    expect(repository.listAssistantFeedbackQueue).not.toHaveBeenCalled();
    expect(writeOutput).not.toHaveBeenCalled();
  });

  it('refuses an output path outside the ignored private export directory before reading the queue', async () => {
    const repository = fakeRepository([queueItem()]);
    const writeOutput = vi.fn(async () => undefined);

    await expect(runAssistantFeedbackExport({
      output: 'assistant-feedback.json',
      limit: 10,
      acknowledgeUnverifiedResidualPii: true
    }, {
      repository,
      writeOutput
    })).rejects.toMatchObject({ code: 'output_must_be_inside_private_directory' });
    expect(repository.listAssistantFeedbackQueue).not.toHaveBeenCalled();
    expect(writeOutput).not.toHaveBeenCalled();
  });
});
