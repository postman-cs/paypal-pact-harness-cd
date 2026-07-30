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

## The Harness pipelines

Two importable pipelines (see [`harness/IMPORT.md`](harness/IMPORT.md)):

- **`harness/contract-gate.pipeline.yaml`** — self-contained proof, **zero secrets**:
  BDC gate (JUnit published), fleet `can-i-deploy` over the committed ledger, and a
  **fail-closed drift proof**. Each step is just `node tools/pact-harness/pact-harness.mjs …`.
- **`harness/contract-gate.real-consumer.pipeline.yaml`** — production shape: pulls the
  consumer collection + provider OAS from Postman, records into a **shared** contracts
  repo, gates on the fleet. Needs `postman_service_pmak` + `ledger_git_token`.

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
