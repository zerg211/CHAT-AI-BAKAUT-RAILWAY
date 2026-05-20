# 2026-05-20 AI Manager Voice Checks

## Commands

```bash
npm test -- tests/postAnswerVerifier.test.ts
```

PASS: 1 file, 13 tests.

```bash
npm test -- tests/assistantControlPlaneGenerate.test.ts
```

PASS: 1 file, 11 tests.

```bash
npm test -- tests/assistantFallback.test.ts tests/assistantControlPlaneGenerate.test.ts tests/remediationCommercialFallback.test.ts tests/assistantLegacyWriterGuard.test.ts tests/postAnswerVerifier.test.ts
```

PASS: 5 files, 51 tests.

```bash
npm test -- tests/recommendationRanking.test.ts tests/agentManagerIntegrationSource.test.ts
```

PASS: 2 files, 209 tests.

```bash
npm run typecheck
```

PASS.

```bash
npm test
```

PASS: 58 files, 502 tests.

```bash
npm run build
```

PASS.

## Notes

- Production live gate is still pending after this local code change.
- Previous production live evidence showed commercial turns still phrased verification as a third-person manager/logistics handoff.
- The new local contract treats that wording as a verifier error and sends it to LLM rewrite before final response.
