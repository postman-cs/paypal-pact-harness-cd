# paypal-pact-harness-cd

Consumer-driven contract testing (Pact BDC) for PayPal, **wired for Harness.** No broker,
no server, no database — the "broker" is a git-backed ledger (`can-i-deploy`), and the
engine ships as an install-free bundle the pipelines call.

**Self-contained — the single source of truth.** This repo carries the engine source
(`src/`), the tests (`test/`), the build (`scripts/build-bundle.mjs` → `tools/pact-harness`),
the fixtures, the Harness pipelines, the demo, and a seeded ledger. It has **no runtime or
build dependency on any other repo.** (The GitHub Actions twin `paypal-pact-actions` is the
same engine on a different runner.)

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

## Develop / rebuild

```bash
npm install          # dev only (yaml, for tests + rebuilding the bundle)
npm test             # 36 engine + ledger tests
npm run check        # determinism: golden pact matches its generator
npm run build:bundle # regenerate tools/pact-harness/ from src/ (what the pipelines run)
```
The **pipelines never `npm install`** — they call the committed `tools/pact-harness` bundle.
`npm install` is only for running the tests or rebuilding that bundle.

## Layout

| Path | What |
| --- | --- |
| `src/`, `test/` | the engine source + its tests (the source of truth) |
| `scripts/build-bundle.mjs` | builds the install-free bundle from `src/` → `tools/pact-harness/` |
| `tools/pact-harness/` | the committed, install-free CLI bundle (what the pipelines call) |
| `contracts/` | the git-backed ledger (pacts, providers, verifications, what's live in `production`) |
| `fixtures/` | real PayPal Orders specs (good + drifted) + consumer pacts/collections |
| `demo/demo.mjs` | the runnable demo (no Harness needed to see it work) |
| `harness/*.pipeline.yaml` + `IMPORT.md` | the gate as Harness pipelines + import steps |

## Actions vs Harness — the point

These two repos are deliberately the same engine on two runners. The contract *intelligence*
(verify + `can-i-deploy` + the ledger) is platform-agnostic; the CI platform only decides
where it executes and where a RED verdict blocks a promotion. Pick the one your promotion
already lives in. (Design rationale: [`docs/DECISIONS.md`](docs/DECISIONS.md) — D12 the git ledger, D13 the bundle.)
