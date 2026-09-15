# Production dialogue #2188 — retrospective buyer/internal audit

- Surface: embedded widget on `https://bakautprof.ru/`
- Session: `355fccf1-14f5-493e-b5d2-5640416cca07`
- First turn: `45a3aa5d-a1f7-4863-887e-c555ae2ef25e` (completed)
- Follow-up: `81ecd066-ddec-495b-bc04-b855e3dc1a2d` (failed)
- Status: historical FAIL; reopened from the user's browser comment on 2026-09-15.

## What the buyer saw

For a 2.9 kW simultaneous running load with unknown motor starts, the assistant showed only A-iPower A6500 6 kW and FUBAG BS 14000 A ES 12 kW. It acknowledged that 12 kW was excessive but still spent one of two visible slots on it. The buyer then asked for a rational choice and a catalog option closer to 5 kW. The widget showed the generic completion error.

## What happened internally

The first catalog artifact contained eight products in this order: 6, 12, 2, 4, 8, 5, 4 and 2.8 kW. The old writer selected the first two rows; 4 and 5 kW products were already present but ranked too late. This was before deterministic generator load ordering was introduced.

On the follow-up, catalog/research found TSS SGG 5000N 5 kW and the writer drafted a useful 5/6 kW recommendation while rejecting 12 kW as unnecessary. Review blocked publication because exact A-iPower web-memory facts had no durable evidence item IDs. That provenance defect was subsequently corrected; the error was not caused by absence of a 5 kW product.

## Permanent contract

For a preliminary generator selection with a validated load reference, proven conflicts are removed first and remaining candidates are ordered by nominal power above the reference before the shortlist is sliced. A missing phase/fuel field remains an explicit uncertainty for web checking and cannot let a much larger complete card displace closer 4–5 kW candidates. Final selection still keeps verified compatibility requirements fail-closed.
