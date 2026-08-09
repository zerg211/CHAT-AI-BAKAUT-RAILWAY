# Exact product identity P1

## RED

Builder recorded contract failures before implementation:

- split `TSS SGG 5000 EH` identity accepted neighboring `EHA` / `EH-A` evidence;
- research retained a neighbor-model fact when the model output mislabeled it as the requested target;
- a web fact without an HTTP(S) URL could fall back to catalog text and become verified.

During integration, the added descriptive-name regression initially remained RED: a catalog name such as `Генератор бензиновый TSS SGG 5000 EH 5 кВт` could not bind to an exact manual mention. The split identity extractor was corrected at the owning utility layer.

## Implementation

- `ExactProductIdentity` centralizes aliases, decisive model parts, ordered matching and strict exact mentions.
- Split model codes require every decisive part in order and reject neighboring suffix extensions.
- Descriptive catalog names extract the bounded model-code span around a numeric anchor rather than treating marketing words and power units as identity.
- Multi-model sources are permitted when all named models are explicit targets; otherwise the source needs semantic binding and cannot silently prove a neighboring modification.
- Web evidence requires a readable absolute HTTP(S) source URL and exact-target provenance; model-provided `productName` alone is insufficient.
- Follow-up RED covered a catalog neighbour: `Husqvarna K 970` carried a `770 мм` blade spec and was therefore misread as exact `Husqvarna K 770` when identity matching concatenated all specs. Exact catalog binding now uses only product identity fields (name, brand, external ID, slug and source URL); technical specs cannot manufacture a model code.

## GREEN

- `npm.cmd test -- --run tests/modelTextMatching.test.ts` → 10/10 PASS.
- `npm.cmd test -- --run tests/productComparisonResearch.test.ts tests/agentManagerComparisonResearch.test.ts tests/modelTextMatching.test.ts tests/verifiedFactMemory.test.ts` → 73/73 PASS.
- The builder also recorded `lint:no-regex` PASS before the final descriptive-name integration fix; root reruns all global gates later.
- Focused exact-model utility + structured catalog filter rerun → 13/13 PASS.

No commit, push or production live verification was performed in this tranche.
