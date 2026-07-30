# paypal-pact-harness-cd

Consumer-driven contract testing (Pact BDC) for PayPal, **wired for Harness.** Identical
capability to the GitHub Actions twin `paypal-pact-actions` — same install-free bundle,
same git-backed ledger, same verdicts. The *only* difference is which runner executes it.
No broker, no server, no database.

Both repos are thin consumers of the bundle from `paypal-pact-harness`.

## Run the demo (zero setup, no Harness needed to see it work)

```bash
node demo/demo.mjs
```

Shows, on real PayPal Orders specs: the immediate BDC gate, recording a proposed provider
release that renames `status`, then `can-i-deploy` the current provider (**YES**) vs the
proposed one (**NO** — blocked by the consumer live in prod). Pure computation over
committed files.

## The Harness pipeline

`harness/contract-gate.pipeline.yaml` is one importable CI pipeline with three steps —
BDC gate, fleet `can-i-deploy` over the committed ledger, and a **fail-closed drift
proof** — each just `node tools/pact-harness/pact-harness.mjs …`. It runs green with **no
secrets** (self-contained on committed fixtures + ledger). The real-consumer variant
(Postman pull + push to a shared contracts repo + `record-deployment` on promotion) is
in the comment at the bottom of that file.

## Layout

| Path | What |
| --- | --- |
| `tools/pact-harness/` | the install-free CLI bundle |
| `contracts/` | the git-backed ledger (pacts, providers, verifications, what's live in `production`) |
| `fixtures/` | real PayPal Orders OAS (good + drifted) + a consumer pact |
| `demo/demo.mjs` | the runnable demo (identical to the Actions twin — the engine is platform-agnostic) |
| `harness/contract-gate.pipeline.yaml` | the whole gate as one Harness pipeline |

## Actions vs Harness — the point

These two repos are deliberately the same engine on two runners. The contract *intelligence*
(verify + `can-i-deploy` + the ledger) is platform-agnostic; the CI platform only decides
where it executes and where a RED verdict blocks a promotion. Pick the one your promotion
already lives in. (Decision D12/D13 in the source repo `paypal-pact-harness`.)
