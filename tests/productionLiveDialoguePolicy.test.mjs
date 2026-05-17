import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeProductionLiveDialogueTurns,
  assertNonRepeatingProductionDialogue,
  dialoguePolicyMarkdown,
  dialogueSignature,
  loadProductionLiveDialogue
} from './productionLiveDialoguePolicy.mjs';

const sampleTurns = [
  { phase: 'first_need', user: 'Need a generator for a small house.' },
  { phase: 'catalog_request', user: 'Show 4-6 kW options, not the expensive ones.' }
];
const productionReadyTurns = [
  { phase: 'need', user: 'Здравствуйте. Нужен генератор для мастерской под компрессор, свет и ручной инструмент.' },
  { phase: 'power', user: 'Не понимаю, хватит ли 7-8 кВт или лучше сразу смотреть запас около 10 кВт.' },
  { phase: 'catalog', user: 'Покажите несколько бензиновых вариантов из каталога без самых дорогих моделей.' },
  { phase: 'service', user: 'Что важно по шуму, обслуживанию и длительной работе несколько часов подряд?' },
  { phase: 'switch', user: 'Еще нужна бетономешалка для небольших заливок во дворе, не игрушечная, но перевозимая.' },
  { phase: 'summary', user: 'Суммируйте, что смотреть по генератору и бетономешалке без обещаний точной доставки.' }
];

async function tempArtifactDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'production-live-dialogue-policy-'));
}

describe('production live dialogue policy', () => {
  it('rejects technically valid but unusable dialogue text', () => {
    const quality = analyzeProductionLiveDialogueTurns([
      { phase: 'bad_encoding', user: 'Р—РґСЂР°РІСЃС‚РІСѓР№С‚Рµ. РќСѓР¶РµРЅ РіРµРЅРµСЂР°С‚РѕСЂ.' },
      { phase: 'duplicate', user: 'Р—РґСЂР°РІСЃС‚РІСѓР№С‚Рµ. РќСѓР¶РµРЅ РіРµРЅРµСЂР°С‚РѕСЂ.' }
    ], { minTurns: 2, minUserLength: 20 });

    expect(quality.ok).toBe(false);
    expect(quality.issues.map((issue) => issue.code)).toContain('suspicious_cyrillic_encoding_artifacts');
    expect(quality.issues.map((issue) => issue.code)).toContain('duplicate_user_text');
  });

  it('accepts readable buyer dialogue text', () => {
    const quality = analyzeProductionLiveDialogueTurns([
      { phase: 'generator_need', user: 'Здравствуйте. Нужен генератор для мастерской под компрессор и свет.' },
      { phase: 'catalog_request', user: 'Покажите варианты около 8-10 кВт, но без самых дорогих моделей.' }
    ], { minTurns: 2, minUserLength: 20 });

    expect(quality).toEqual({ ok: true, issues: [] });
  });

  it('allows a first unseen dialogue and returns auditable metadata', async () => {
    const artifactDir = await tempArtifactDir();

    const policy = await assertNonRepeatingProductionDialogue({
      scriptName: 'test diverse production audit',
      scenarioName: 'sample-v1',
      turns: sampleTurns,
      artifactDir,
      env: {}
    });

    expect(policy.policy).toBe('non_repeating_production_live_dialogue');
    expect(policy.scenarioName).toBe('sample-v1');
    expect(policy.dialogueSignature).toHaveLength(64);
    expect(policy.turnPhases).toEqual(['first_need', 'catalog_request']);
    expect(dialoguePolicyMarkdown(policy).join('\n')).toContain(policy.dialogueSignature);
  });

  it('blocks a dialogue whose signature already exists in production artifacts', async () => {
    const artifactDir = await tempArtifactDir();
    const signature = dialogueSignature(sampleTurns);
    await fs.writeFile(
      path.join(artifactDir, '2026-05-17-production-diverse-buyer-audit.production.md'),
      `Dialogue signature: ${signature}\n`,
      'utf8'
    );

    await expect(assertNonRepeatingProductionDialogue({
      scriptName: 'test diverse production audit',
      scenarioName: 'sample-v1',
      turns: sampleTurns,
      artifactDir,
      env: {}
    })).rejects.toMatchObject({
      message: 'production_live_dialogue_signature_repeated',
      details: {
        dialogueSignature: signature,
        priorMatches: [expect.stringContaining('2026-05-17-production-diverse-buyer-audit.production.md')]
      }
    });
  });

  it('ignores an explicitly excluded scenario file while checking repeats', async () => {
    const artifactDir = await tempArtifactDir();
    const scenarioFile = path.join(artifactDir, 'prepared-scenario.json');
    const signature = dialogueSignature(sampleTurns);
    await fs.writeFile(scenarioFile, JSON.stringify({ dialogueSignature: signature, turns: sampleTurns }), 'utf8');

    const policy = await assertNonRepeatingProductionDialogue({
      scriptName: 'test diverse production audit',
      scenarioName: 'sample-v1',
      turns: sampleTurns,
      artifactDir,
      env: {},
      excludePaths: [scenarioFile]
    });

    expect(policy.dialogueSignature).toBe(signature);
    expect(policy.priorMatches).toEqual([]);
  });

  it('allows a repeated dialogue only with explicit override', async () => {
    const artifactDir = await tempArtifactDir();
    const signature = dialogueSignature(sampleTurns);
    await fs.writeFile(
      path.join(artifactDir, 'prior.json'),
      JSON.stringify({ productionLiveDialoguePolicy: { dialogueSignature: signature } }),
      'utf8'
    );

    const policy = await assertNonRepeatingProductionDialogue({
      scriptName: 'test diverse production audit',
      scenarioName: 'sample-v1',
      turns: sampleTurns,
      artifactDir,
      env: { ALLOW_REPEAT_PRODUCTION_LIVE_DIALOGUE: '1' }
    });

    expect(policy.repeatedDialogueOverride).toBe(true);
    expect(policy.dialogueSignature).toBe(signature);
  });

  it('requires an explicit external scenario or bundled override', async () => {
    await expect(loadProductionLiveDialogue({
      defaultTurns: sampleTurns,
      defaultScenarioName: 'bundled-v1',
      env: {}
    })).rejects.toMatchObject({
      message: 'bundled_production_live_dialogue_not_approved',
      details: {
        requiredEnv: expect.objectContaining({
          PRODUCTION_LIVE_DIALOGUE_FILE: expect.any(String)
        })
      }
    });
  });

  it('loads a fresh scenario file before production live execution', async () => {
    const artifactDir = await tempArtifactDir();
    const scenarioFile = path.join(artifactDir, 'fresh-scenario.json');
    await fs.writeFile(scenarioFile, JSON.stringify({
      scenarioName: 'fresh-final-live-v2',
      turns: productionReadyTurns
    }), 'utf8');

    const dialogue = await loadProductionLiveDialogue({
      defaultTurns: [{ phase: 'bundled', user: 'Bundled prompt.' }],
      defaultScenarioName: 'bundled-v1',
      scenarioFile,
      env: {}
    });

    expect(dialogue.source).toBe('file');
    expect(dialogue.scenarioName).toBe('fresh-final-live-v2');
    expect(dialogue.turns).toEqual(productionReadyTurns);
    expect(dialogue.scenarioFile).toBe(scenarioFile);
  });

  it('allows bundled scenario only with explicit override', async () => {
    const dialogue = await loadProductionLiveDialogue({
      defaultTurns: sampleTurns,
      defaultScenarioName: 'bundled-v1',
      env: { ALLOW_BUNDLED_PRODUCTION_LIVE_DIALOGUE: '1' }
    });

    expect(dialogue.source).toBe('bundled');
    expect(dialogue.scenarioName).toBe('bundled-v1');
    expect(dialogue.turns).toEqual(sampleTurns);
  });
});
