# paypal-pact-harness-cd

Consumer-driven contract testing (Pact BDC) for PayPal, wired for **GitHub Actions and
Harness Kubernetes stages**. No broker, server, or database is required for the phase-0
gate: the deployment matrix is a git-backed ledger (`can-i-deploy`) and the consumer
engine ships as an install-free bundle.

**Consumer engine source of truth.** This repo carries the engine source
(`src/`), the tests (`test/`), the build (`scripts/build-bundle.mjs` → `tools/pact-harness`),
the fixtures, the GitHub composite action, Harness stages, the Orders Spring Boot lower-
environment wrapper, and a seeded ledger. Application-route parity and rogue endpoint
detection resolve the production
[`postman-cs/paypal-harness-postman-stages`](https://github.com/postman-cs/paypal-harness-postman-stages)
comparator at the full commit and SHA-256 recorded in `postman-cs.lock.json`; that capability
is intentionally not copied into a personal wrapper.

## Run the demo (zero setup, no Harness needed to see it work)

```bash
node demo/demo.mjs
```

Shows, on real PayPal Orders specs: the immediate BDC gate, recording a proposed provider
release that renames `status`, then `can-i-deploy` the current provider (**YES**) vs the
proposed one (**NO** — blocked by the consumer live in prod). Pure computation over
committed files.

## GitHub Action

`action.yml` is the modular gate for an existing workflow. It accepts a consumer Pact,
consumer OAS, or Postman collection; verifies the consumer expectations against the provider
OAS; and optionally compares the selected OAS routes to a live application route inventory in
both directions.

`.github/workflows/contract-gate.yml` tests the engine, runs the action against committed
Orders evidence, starts the real Spring Boot wrapper, gates its generated `/v3/api-docs`
inventory, proves consumer drift and rogue endpoints fail closed, and publishes an immutable
lower-environment image.

## Harness stages and pipelines

See [`harness/IMPORT.md`](harness/IMPORT.md):

- `harness/stages/consumer-contract-gate.yaml` — drop-in KubernetesDirect stage for an
  existing PayPal pipeline; the first run is locked to the `lower` environment.
- `harness/contract-gate.lower.pipeline.yaml` — complete lower-environment import template.
- `harness/contract-gate.self-test.pipeline.yaml` — zero-secret Harness Cloud proof, usable
  while a Kubernetes delegate is unavailable.
- `harness/contract-gate.real-consumer.pipeline.yaml` — Postman-backed production shape,
  with Postman CLI used where a native primitive exists.

## Develop / rebuild

```bash
npm install          # dev only (yaml, for tests + rebuilding the bundle)
npm test             # engine, ledger, topology, and supply-chain tests
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
| `action.yml`, `.github/workflows/` | modular GitHub action and executable end-to-end proof |
| `demo/orders-spring/`, `k8s/` | Orders Spring Boot wrapper and lower-environment manifest |
| `config/` | selected spec subset and explicit application/spec relationship graph |
| `contracts/` | the git-backed ledger (pacts, providers, verifications, what's live in `production`) |
| `fixtures/` | real PayPal Orders specs (good + drifted) + consumer pacts/collections |
| `demo/demo.mjs` | the runnable demo (no Harness needed to see it work) |
| `harness/` | drop-in stage plus self-test, lower, and Postman-backed pipeline templates |

## Actions vs Harness — the point

The contract intelligence is platform-agnostic; the CI platform only decides where it executes
and where a red verdict blocks promotion. The action and Harness stage invoke the same bundled
engine, the same Postman-CS comparator, and the same relationship/subset inputs. See
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) for the evidence map and
[`docs/CONSUMER-DRIVEN.md`](docs/CONSUMER-DRIVEN.md) for the recommended production evolution.
