# Task: product classifier oil/liter parser no-regex pass

## Scope

Replace the focused regex usage in `src/ai/productClassifier.ts` for oil viscosity extraction and requested liter extraction with deterministic character scanners.

This is not a semantic buyer-intent change. The current code parses explicit technical facts already present in text:
- oil viscosity tokens such as `10w40` or `10w-40`;
- package volume tokens such as `1 л`, `1.5l`, or `2 литра`.

The LLM remains responsible for understanding buyer meaning and dialogue policy. This pass only keeps fact parsing executable without regex.

## Acceptance Criteria

AC1. `oilViscosities(text)` returns the same normalized viscosity values for supported legacy forms without using regex.

AC2. `requestedLiters(text)` returns the same positive liter value for supported legacy forms without using regex.

AC3. Public exports and call sites remain stable.

AC4. Focused unit tests cover the no-regex parser behavior.

AC5. Local non-OpenAI validation passes:
- `npm run lint:no-regex`
- focused product classifier tests
- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`

AC6. After commit and push, production Promptfoo/widget harness is run against the Railway deployment and scores are recorded.

## Proposed Pass

Current behavior:
- `oilViscosities` uses a regex to extract explicit SAE viscosity tokens.
- `requestedLiters` uses a regex to extract explicit volume tokens.

Structural improvement:
- Replace those regexes with small scanners that parse numbers, boundaries, optional separators, and unit suffixes directly.
- Keep semantic product selection and dialogue decisions out of this code path.

Validation check:
- Existing and new unit tests must pass.
- `lint:no-regex` finding count must not increase and should decrease.
- Production eval must stay above the current target threshold after push.
