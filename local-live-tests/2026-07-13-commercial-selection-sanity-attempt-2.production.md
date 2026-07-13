# Production live protocol: commercial selection sanity, attempt 2

- Date: 2026-07-13
- Site: embedded widget on `https://bakautprof.ru/`
- Production commit: `5c3f0b223588a36b26b3beaee395dc7b1787cb35`
- Session: `710f559f-a5cb-415e-9b43-194ea500afd5`
- Verdict: NOT CLEAN under AC13

## Buyer-view audit

1. The assistant asked for the actual loads after an initial broad dacha-generator request.
2. For a 1.1 kW pump plus 1.5 kW grinder, 220 V, simultaneous operation, it calculated a 4.5 kW minimum and showed TSS 5.0 kW / 49,281 RUB, FIRMAN 5.0 kW / 57,200 RUB, EVOline 5.0 kW / 64,990 RUB, and FUBAG 5.0 kW / 71,180 RUB.
3. After the buyer requested 2-3 gasoline single-phase 5-6 kW models with prices and said the nameplate was unavailable, it showed DAEWOO GDA6600Ei 5.5 kW / 94,990 RUB, TSS SGG5000N 5.0 kW / 49,281 RUB, and A-iPower A6000LIS 5.5 kW / 105,990 RUB.
4. On "what should I buy without overpaying?" it recommended TSS at 49,281 RUB and retained all three comparison cards.

Buyer-visible facts, prices, recommendation, and cards were consistent.

## Admin metadata audit

- Turns 1, 2, and 4: `completed`.
- Turn 3: `recovered`, no fallback text and no lost product evidence.
- Turn 3 retained strict gasoline and phase requirements, historical selection evidence, correct answer product IDs, and matching cards.
- Pre-send review: `pass`.
- Trace showed original execution reached a durable answer checkpoint, stopped before review/save, then same-turn recovery reused the saved ledger, intent, tool artifacts, and answer contract and saved the correct response.

Despite correct buyer-visible behavior, this is not accepted as a clean proof dialogue because AC13 explicitly rejects a recovered proof turn.
