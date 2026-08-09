import { describe, expect, it } from 'vitest';

import { AI_MANAGER_RUNTIME_MANIFEST } from '../src/ai/aiManagerRuntimeManifest.ts';
import {
  expectedAiManagerContractVersion,
  expectedAiManagerRuntimeVersion
} from './productionRuntimeMarker.mjs';

describe('production runtime marker defaults', () => {
  it('tracks the current sole-runtime manifest instead of a stale copied version', () => {
    expect(expectedAiManagerRuntimeVersion).toBe(AI_MANAGER_RUNTIME_MANIFEST.version);
    expect(expectedAiManagerContractVersion).toBe(AI_MANAGER_RUNTIME_MANIFEST.contractVersion);
  });
});
