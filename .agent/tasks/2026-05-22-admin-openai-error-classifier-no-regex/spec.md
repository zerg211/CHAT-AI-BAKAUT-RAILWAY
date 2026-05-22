# Admin OpenAI Error Classifier No-Regex Pass

## Problem

`src/routes/admin.ts` classifies OpenAI runtime probe failures with regular expressions. This is legacy deterministic infrastructure code, not buyer-dialogue semantics, and it violates the new project rule that regex should not be added and old regex should be removed in small passes.

## Current Behavior

`safeOpenAIError` returns one of these classes from status/body text:

- `quota_or_billing`
- `authentication`
- `provider_access_region`
- `rate_limit`
- `model_project_or_org_access`
- `network_or_timeout`
- `unknown`

## Structural Improvement

Replace the regex checks with a small deterministic phrase/status classifier:

- exact status values handle `401`, `403`, and `429`;
- lowercase phrase inclusion handles provider error codes/messages;
- no semantic buyer behavior changes;
- no regex added.

## Validation

- Unit tests cover the same classifier classes.
- `npm run lint:no-regex` must reduce or keep the legacy baseline from increasing.
- Admin route/runtime behavior stays stable because `safeOpenAIError` still returns the same class names.

## Acceptance Criteria

- AC1: `src/routes/admin.ts` has no regex literals or regex constructor calls.
- AC2: Classifier returns the same expected class names for quota, auth, unsupported region, rate limit, model/project/org access, network/timeout, and unknown cases.
- AC3: No new regex constructs are added.
- AC4: Targeted admin tests pass.
- AC5: Local non-OpenAI gates pass.
