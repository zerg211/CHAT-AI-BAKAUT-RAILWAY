# Exact multipart catalog fix — production verification

## Deployment

- Commit pushed to `main`: `ba18670` (`fix(catalog): recover exact multipart model cards`).
- Railway linked project `laudable-unity`, production service `chat-ai` reported `Online` after the new deployment (`3e7b114e-0376-41ae-97dc-b3dc81ee13a2`).
- Post-deploy commit marker and widget interaction were not readable from this execution environment: direct DNS/HTTP access to `chat.bakautprof.ru` and `bakautprof.ru` is blocked (`curl` network error; Playwright `ERR_NETWORK_ACCESS_DENIED`). No live PASS is claimed here.

## Why the original failure was real

The public product page exists: `https://bakautprof.ru/catalog/vibroplity/vibroplita_pryamokhodnaya_benzinovaya_wacker_neuson_bps_1550_aw_89_kg/` and exposes the BPS 1550 Aw card/article. The previous widget trace nevertheless produced catalog absence because split identity `BPS 1550 Aw` was not recognized by `modelIdentifierTokens()` when the planner omitted `productMentions`; no exact catalog lookup/refresh was then executed.

## Required remaining live check

Open `https://bakautprof.ru/`, use the embedded widget, and send the buyer's exact request about `Wacker Neuson BPS 1550 Aw` with `Honda GX160 QX2`. Confirm from the visible UI and admin trace that:

1. the BPS card is returned before/alongside external research;
2. Honda is treated as compatibility/service context, not as a replacement plate;
3. catalog facts are separated from official external service facts;
4. an interrupted external search does not state that BPS is absent;
5. the next adaptive buyer turn uses the actual returned card/answer.

This file intentionally remains a deployment/live evidence gap until that widget run is performed.
