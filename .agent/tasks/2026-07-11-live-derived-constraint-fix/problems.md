# Problems

## Resolved locally

- A derived operating scenario was conflated with a product attribute.
- A successful typed calculation could previously be bypassed or misbound by planner-controlled fields.
- Maximum power, apparent power in kVA and unlabeled display power could be mistaken for confirmed nominal kW.
- The strict nominal parser initially missed Bakaut's real catalog shape where `кВт` is in the specification key and the numeric value is unitless; it now handles that shape without accepting kVA.
- Catalog search could execute before its calculator dependency or stop after a weak initial pool.
- Recovery replanning could reuse a stale same-ID tool artifact for different inputs.
- The buyer-facing fallback incorrectly blamed missing product characteristics when the actual failure was a tool/calculation problem.

## Pending release proof

- Commit and push to GitHub `main`.
- Railway automatic deployment marker equal to the pushed SHA.
- Adaptive production replay through the embedded widget on `bakautprof.ru`.
- Authenticated inspection of the replay's tool artifacts, warnings, review trace and visible cards.
