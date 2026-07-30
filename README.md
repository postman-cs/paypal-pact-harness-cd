# paypal-pact-harness-cd

Consumer-driven contract testing for PayPal, packaged as one install-free command
and one importable Harness Kubernetes stage. The gate has no server or database.

## PayPal TPE: start here

Requirements: Git and Node 20 or newer.

```bash
git clone https://github.com/postman-cs/paypal-pact-harness-cd.git
cd paypal-pact-harness-cd
node paypal-contract-gate.mjs doctor
node paypal-contract-gate.mjs verify --clean
```

No `npm install`, Docker, Pact Broker, or dedicated host is needed for this proof.
The first command checks the machine, profile, files, and locked Postman-CS
dependency. The second runs the complete lower-environment gate and writes JUnit,
JSON, and checksums under `.contract-reports/`.

To adapt it, edit the single secret-free
[`paypal-contract-gate.config.json`](paypal-contract-gate.config.json). For the
five-minute handoff and live-service environment variables, see
[`PAYPAL-TPE-QUICKSTART.md`](PAYPAL-TPE-QUICKSTART.md).

**Consumer engine source of truth.** This repo carries the engine source
(`src/`), the tests (`test/`), the build (`scripts/build-bundle.mjs` → `tools/pact-harness`),
the fixtures, the GitHub composite action, Harness stages, the Orders Spring Boot lower-
environment wrapper, and a seeded ledger. Application-route parity and rogue endpoint
detection vendor the exact comparator from the production
[`postman-cs/paypal-harness-postman-stages`](https://github.com/postman-cs/paypal-harness-postman-stages)
repository at the full commit and SHA-256 recorded in `postman-cs.lock.json`. CI
verifies that digest before executing it, with no runtime network dependency.

## Optional ledger demo

```bash
node demo/demo.mjs
```

Shows, on real PayPal Orders specs: the immediate BDC gate, recording a proposed provider
release that renames `status`, then `can-i-deploy` the current provider (**YES**) vs the
proposed one (**NO** — blocked by the consumer live in prod). Pure computation over
committed files.

## GitHub Action

`action.yml` is the modular gate for an existing workflow. It accepts a consumer Pact,
consumer OAS, or Postman collection; verifies deep request/response schemas and consumer
examples against the provider OAS; audits operation security and positive/negative cases;
optionally checks a selected-surface OAS diff; validates governed mismatch exceptions; and
compares selected OAS routes to a live application inventory in both directions.

`.github/workflows/contract-gate.yml` tests the engine, runs the action against committed
Orders evidence, starts the real Spring Boot wrapper, gates authoritative
`/actuator/mappings`, cross-checks generated `/v3/api-docs`, uses Postman CLI 1.44.0 for
authenticated positive and negative cases, proves schema drift and rogue endpoints fail
closed, uploads JUnit/JSON plus the packaged CLI, and publishes an immutable image.

## Harness stages and pipelines

See [`harness/IMPORT.md`](harness/IMPORT.md):

- `harness/stages/consumer-contract-gate.yaml` — drop-in KubernetesDirect stage for an
  existing PayPal pipeline; the first run is locked to the `lower` environment.
- `harness/contract-gate.lower.pipeline.yaml` — complete lower-environment Kubernetes
  import template with the Spring app as an ephemeral Background step.
- `harness/contract-gate.self-test.pipeline.yaml` — zero-secret Harness Cloud proof, usable
  while a Kubernetes delegate is unavailable.
- `harness/contract-gate.real-consumer.pipeline.yaml` — Postman-backed future service shape,
  with Postman CLI used where a native primitive exists.

The complete component map and execution sequence are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Maintainers: develop / rebuild

```bash
npm install          # dev only (yaml, for tests + rebuilding the bundle)
npm test             # engine, ledger, topology, and supply-chain tests
npm run check        # determinism: golden pact matches its generator
npm run build:bundle # regenerate tools/pact-harness/ from src/ (what the pipelines run)
npm run package:bundle # produce the portable .tgz + SHA-256 release metadata in dist/
npm run test:packed    # extract the .tgz in a clean path and prove it needs no install
npm run test:all       # full local release gate
```
The **pipelines never `npm install`** — they call the committed `tools/pact-harness` bundle.
`npm install` is only for running the tests or rebuilding that bundle.

## Layout

| Path | What |
| --- | --- |
| `src/`, `test/` | the engine source + its tests (the source of truth) |
| `scripts/build-bundle.mjs` | builds the install-free bundle from `src/` → `tools/pact-harness/` |
| `tools/pact-harness/` | the committed, install-free CLI bundle (what the pipelines call) |
| `paypal-contract-gate.mjs`, `paypal-contract-gate.config.json` | TPE-friendly entry point and single versioned profile |
| `PAYPAL-TPE-QUICKSTART.md` | clone-to-green handoff and live lower-service setup |
| `action.yml`, `.github/workflows/` | modular GitHub action and executable end-to-end proof |
| `demo/orders-spring/`, `k8s/` | Orders Spring Boot wrapper and lower-environment manifest |
| `config/` | subset selectors, contract policy, governed exceptions, and app/spec graph |
| `contracts/` | the git-backed ledger (pacts, providers, verifications, what's live in `production`) |
| `fixtures/` | real PayPal Orders specs (good + drifted) + consumer pacts/collections |
| `demo/demo.mjs` | the runnable demo (no Harness needed to see it work) |
| `harness/` | drop-in stage plus self-test, lower, and Postman-backed pipeline templates |
| `docs/ARCHITECTURE.md` | complete system map, execution sequence, evidence flow, and ownership boundaries |

## Actions vs Harness — the point

GitHub packages and validates the code, uploads evidence, and publishes the demo image.
Harness is the PayPal execution and promotion-control plane: its modular stage runs the same
bundle inside the existing Kubernetes pipeline and a red verdict blocks the downstream
promotion. Neither platform owns the contract logic. See
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) for the evidence map and
[`docs/CONSUMER-DRIVEN.md`](docs/CONSUMER-DRIVEN.md) for the recommended production evolution.
