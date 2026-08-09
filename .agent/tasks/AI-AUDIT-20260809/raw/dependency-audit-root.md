# Dependency audit — 2026-08-09

## Initial production signal

`npm.cmd audit --omit=dev --audit-level=high` returned exit 1 with three High findings in the installed production tree:

- `undici` 7.28.0;
- `fast-uri` 3.1.4;
- `brace-expansion` 5.0.8.

No new dependency was added. The existing direct `undici` range was raised to `^7.29.0`; compatible overrides were added for `fast-uri ^3.1.5` and `brace-expansion ^5.0.9`; the lockfile was regenerated with lifecycle scripts disabled.

## Current production signal

Command: `npm.cmd audit --omit=dev --audit-level=high`

Result: exit 0, `found 0 vulnerabilities`.

## Residual dev-only signal

Command: `npm.cmd audit --audit-level=high`

Result: exit 1, five High transitive findings under the development-only `promptfoo -> @huggingface/transformers -> onnxruntime-node` path (`adm-zip <0.6.0` and `sharp <0.35.0`). The only automated full remediation offered by npm is a forced breaking downgrade to `promptfoo@0.120.14`; it was not applied because it would intentionally violate the current dependency contract and may regress eval behavior. These packages are omitted from the production install/audit signal and are not part of the Railway runtime path.

This residual risk must be revisited when Promptfoo/HuggingFace publish a compatible dependency tree. Until then, do not feed untrusted ZIP/image artifacts into optional local Promptfoo transformer features.
