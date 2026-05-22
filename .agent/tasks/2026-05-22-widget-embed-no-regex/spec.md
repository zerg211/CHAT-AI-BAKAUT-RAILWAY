# Widget Embed No-Regex Pass

## Problem

`src/routes/widget.ts` embeds legacy regex operations inside the generated launcher script:

- trailing slash trimming for `chatSrc`;
- pixel-size parsing for width/height;
- HTML escaping.

These are deterministic string-processing tasks. They do not require regex and should be moved to explicit helper functions to reduce the legacy regex baseline without changing widget behavior.

## Current Behavior

- Existing embed snippets still work through `/widget.js` and `/embed.js`.
- `data.chatSrc` trailing slashes are removed before building iframe URL.
- Width and height values lower than minimum pixel values are clamped.
- Launcher text/photo fields are HTML-escaped.

## Structural Improvement

Replace inline regex operations in the generated script with named deterministic helpers:

- `trimTrailingSlashes`;
- `pixelNumber`;
- loop-based `esc`.

## Acceptance Criteria

- AC1: `src/routes/widget.ts` has no regex literals or regex constructor calls.
- AC2: `/widget.js` still contains the same embed compatibility markers and minimum size behavior.
- AC3: No new regex constructs are added.
- AC4: Targeted app/widget tests pass.
- AC5: Local non-OpenAI gates pass.
