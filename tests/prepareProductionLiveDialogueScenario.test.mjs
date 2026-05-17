import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getScenarioVariant,
  prepareProductionLiveDialogueScenario,
  productionLiveScenarioVariants
} from './prepareProductionLiveDialogueScenario.mjs';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'prepare-production-live-scenario-'));
}

describe('prepare production live dialogue scenario', () => {
  it('lists several materially different scenario variants', () => {
    expect(Object.keys(productionLiveScenarioVariants).length).toBeGreaterThanOrEqual(3);
    expect(getScenarioVariant('workshop_welder_compressor_bundle').turns.length).toBeGreaterThanOrEqual(6);
    expect(getScenarioVariant('farm_pump_generator_plate').turns[0].user).not.toBe(
      getScenarioVariant('workshop_welder_compressor_bundle').turns[0].user
    );
  });

  it('creates a JSON scenario file with launch env metadata', async () => {
    const artifactDir = await tempDir();
    const outputDir = path.join(artifactDir, 'scenarios');

    const result = await prepareProductionLiveDialogueScenario({
      variantName: 'farm_pump_generator_plate',
      artifactDir,
      outputDir,
      now: new Date('2026-05-17T12:00:00.000Z'),
      env: {}
    });

    const raw = await fs.readFile(result.outputPath, 'utf8');
    const scenario = JSON.parse(raw);
    expect(scenario.scenarioName).toBe('final-live-farm_pump_generator_plate-2026-05-17T12-00-00-000Z');
    expect(scenario.variantName).toBe('farm_pump_generator_plate');
    expect(scenario.turns.length).toBeGreaterThanOrEqual(6);
    expect(scenario.dialogueSignature).toHaveLength(64);
    expect(result.commandEnv.PRODUCTION_LIVE_DIALOGUE_FILE).toBe(result.outputPath);
  });

  it('blocks preparing the same variant again when its signature is already present', async () => {
    const artifactDir = await tempDir();
    const outputDir = path.join(artifactDir, 'scenarios');
    await prepareProductionLiveDialogueScenario({
      variantName: 'rental_team_diesel_generator_trowel',
      artifactDir,
      outputDir,
      now: new Date('2026-05-17T12:00:00.000Z'),
      env: {}
    });

    await expect(prepareProductionLiveDialogueScenario({
      variantName: 'rental_team_diesel_generator_trowel',
      artifactDir,
      outputDir,
      now: new Date('2026-05-17T12:05:00.000Z'),
      env: {}
    })).rejects.toMatchObject({
      message: 'production_live_dialogue_signature_repeated'
    });
  });

  it('fails clearly for an unknown variant', () => {
    expect(() => getScenarioVariant('missing')).toThrow('unknown_production_live_scenario_variant');
  });
});
