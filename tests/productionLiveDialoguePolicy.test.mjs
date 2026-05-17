import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNonRepeatingProductionDialogue,
  dialoguePolicyMarkdown,
  dialogueSignature
} from './productionLiveDialoguePolicy.mjs';

const sampleTurns = [
  { phase: 'first_need', user: 'Need a generator for a small house.' },
  { phase: 'catalog_request', user: 'Show 4-6 kW options, not the expensive ones.' }
];

async function tempArtifactDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'production-live-dialogue-policy-'));
}

describe('production live dialogue policy', () => {
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
});
