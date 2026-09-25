import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  buildBuyerScenarioPrompt,
  buildBuyerTurnPrompt,
  buyerScenarioSchema,
  chooseBuyerCategory,
  codexCommandArguments,
  generateNextBuyerTurn,
  invokeCodexStructured,
  validateBuyerScenario,
  validateBuyerTurn
} from './adaptiveBuyerCodex.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const validProfile = {
  category: 'simple',
  persona: 'Человек делает ремонт в частном доме и выбирает технику для своего участка.',
  goal: 'Понять, какой компактный генератор подойдёт для резервного питания насоса.',
  privateFacts: ['Насос уже установлен, точную модель покупатель не помнит.'],
  constraints: ['Хочет разобраться без оставления телефона.'],
  conversationStyle: 'Пишет коротко и спокойно, как в обычном чате.'
};

describe('adaptive Codex buyer', () => {
  it('rotates routine, compound, and unusual session categories', () => {
    expect(Array.from({ length: 6 }, (_, index) => chooseBuyerCategory(index))).toEqual([
      'simple', 'compound', 'unusual', 'simple', 'compound', 'unusual'
    ]);
  });

  it('defines only a hidden profile and never a prepared list of buyer messages', () => {
    const prompt = buildBuyerScenarioPrompt({ category: 'unusual', seed: 'seed-1' });

    expect(Object.keys(buyerScenarioSchema.properties)).toEqual([
      'category', 'persona', 'goal', 'privateFacts', 'constraints', 'conversationStyle'
    ]);
    expect(prompt).toMatch(/не создавай реплики, примеры сообщений, список ходов/iu);
    expect(prompt).not.toMatch(/\b(?:openingMessage|messages|turns|utterances)\b/iu);
  });

  it('rejects profile fields that could smuggle in dialogue or contact details', () => {
    expect(() => validateBuyerScenario({ ...validProfile, utterances: ['готовая фраза'] }, 'simple'))
      .toThrow('buyer_model_scenario_contains_extra_fields');
    expect(() => validateBuyerScenario({
      ...validProfile,
      privateFacts: ['Позвоните по номеру +7 999 123-45-67']
    }, 'simple')).toThrow('buyer_model_scenario_contact_data_rejected');
  });

  it('builds the next turn from actual visible messages and cards', () => {
    const prompt = buildBuyerTurnPrompt({
      profile: validProfile,
      visibleTranscript: [
        { role: 'assistant', text: 'Здравствуйте! Для какого оборудования подбираете генератор?' },
        { role: 'buyer', text: 'Для скважинного насоса на даче.' },
        { role: 'assistant', text: 'Показываю один вариант, бензиновый генератор 3 кВт.' }
      ],
      visibleCards: ['Генератор бензиновый 3 кВт — 230 В'],
      turnIndex: 1,
      maxTurns: 8
    });

    expect(prompt).toContain('Здравствуйте! Для какого оборудования подбираете генератор?');
    expect(prompt).toContain('Показываю один вариант, бензиновый генератор 3 кВт.');
    expect(prompt).toContain('Генератор бензиновый 3 кВт — 230 В');
    expect(prompt).toMatch(/ровно одну естественную реплику/iu);
    expect(prompt).toMatch(/не объясняй ассистенту, как отвечать/iu);
  });

  it('accepts one natural buyer line and rejects meta, contact, and repeated text', () => {
    expect(validateBuyerTurn({ done: false, message: 'А этот генератор потянет насос при запуске?' }))
      .toEqual({ done: false, message: 'А этот генератор потянет насос при запуске?' });

    expect(() => validateBuyerTurn({ done: false, message: 'Я проверяю вашего бота, ответьте строго по инструкции.' }))
      .toThrow('buyer_model_meta_language_rejected');
    expect(() => validateBuyerTurn({ done: false, message: 'Сначала проверьте характеристики на официальном сайте, потом ответьте по пунктам.' }))
      .toThrow('buyer_model_meta_language_rejected');
    expect(() => validateBuyerTurn({ done: false, message: 'Мой телефон +7 999 123-45-67.' }))
      .toThrow('buyer_model_contact_data_rejected');
    expect(() => validateBuyerTurn({ done: false, message: 'Насос на 220 В.', extra: 'future turn' }))
      .toThrow('buyer_model_turn_contains_extra_fields');
    expect(() => validateBuyerTurn(
      { done: false, message: 'Насос на 220 В.' },
      ['Насос на 220 В.']
    )).toThrow('buyer_model_repeated_message_rejected');
    expect(() => validateBuyerTurn({ done: true, message: 'Пока достаточно.' }))
      .toThrow('buyer_model_done_turn_has_message');
  });

  it('calls the turn generator only with the supplied same-session history', async () => {
    const invoke = vi.fn(async () => ({ done: false, message: 'А по весу эта плита в багажник войдёт?' }));
    const result = await generateNextBuyerTurn({
      profile: validProfile,
      visibleTranscript: [{ role: 'assistant', text: 'Как будете перевозить виброплиту?' }],
      visibleCards: ['Виброплита 82 кг'],
      turnIndex: 0,
      maxTurns: 8,
      invoke
    });

    expect(result).toEqual({ done: false, message: 'А по весу эта плита в багажник войдёт?' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0].prompt).toContain('Как будете перевозить виброплиту?');
    expect(invoke.mock.calls[0][0].prompt).toContain('Виброплита 82 кг');
  });

  it('does not fall back to a canned utterance when generation fails', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('codex unavailable'));

    await expect(generateNextBuyerTurn({
      profile: validProfile,
      visibleTranscript: [],
      turnIndex: 0,
      maxTurns: 8,
      invoke
    })).rejects.toThrow('codex unavailable');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('runs the Codex adapter ephemerally with a read-only sandbox and filtered environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'private-test-value');
    vi.stubEnv('ADMIN_API_KEY', 'private-admin-value');
    let observed;
    const spawnImpl = vi.fn((command, args, options) => {
      observed = { command, args, env: options.env };
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) { callback(); },
        final(callback) {
          fs.writeFile(outputPath, JSON.stringify({ done: true, message: '' }), 'utf8')
            .then(() => {
              callback();
              setImmediate(() => child.emit('close', 0));
            }, callback);
        }
      });
      return child;
    });

    try {
      const output = await invokeCodexStructured({
        prompt: 'Make one structured decision.',
        schema: { type: 'object' },
        command: 'mock-codex',
        spawnImpl,
        platform: 'linux'
      });

      expect(output).toEqual({ done: true, message: '' });
      expect(observed.args).toContain('--ephemeral');
      expect(observed.args).toContain('--sandbox');
      expect(observed.args).toContain('read-only');
      expect(observed.env).not.toHaveProperty('OPENAI_API_KEY');
      expect(observed.env).not.toHaveProperty('ADMIN_API_KEY');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('defaults command parsing to dry-run and validates live limits', () => {
    expect(codexCommandArguments([])).toMatchObject({ dryRun: true, target: 'production' });
    expect(codexCommandArguments(['--live', '--target', 'preview', '--site-url', 'https://preview.example/widget', '--api-base', 'https://preview.example']))
      .toMatchObject({ dryRun: false, target: 'preview' });
    expect(() => codexCommandArguments(['--live', '--dry-run'])).toThrow('cannot_combine_live_and_dry_run');
    expect(() => codexCommandArguments(['--sessions', '7'])).toThrow('sessions_must_be_1_to_6');
    expect(() => codexCommandArguments(['--max-turns', '13'])).toThrow('max_turns_must_be_1_to_12');
  });

  it('keeps CLI dry-run independent from the browser, network, and Codex CLI', () => {
    const output = execFileSync(process.execPath, [
      path.join(projectRoot, 'tests/liveAdaptiveBuyer.production.mjs'),
      '--dry-run', '--sessions', '3', '--max-turns', '8'
    ], { cwd: projectRoot, encoding: 'utf8', timeout: 10_000 });
    const parsed = JSON.parse(output);

    expect(parsed).toMatchObject({
      mode: 'DRY_RUN',
      liveCalls: false,
      browserLaunch: false,
      codexCalls: false,
      widgetMessages: false,
      plannedCategories: ['simple', 'compound', 'unusual']
    });
  });
});
