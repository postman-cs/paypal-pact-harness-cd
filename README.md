# paypal-pact-harness-cd

Postman-first contract testing for PayPal: an install-free static BDC and provider
conformance gate, plus importable Harness stages for the complete open-source Pact
consumer/provider lifecycle.

## PayPal TPE: start here

Requirements: Git and Node 20 or newer.

```bash
git clone https://github.com/postman-cs/paypal-pact-harness-cd.git
cd paypal-pact-harness-cd
node paypal-contract-gate.mjs doctor
node paypal-contract-gate.mjs verify --clean
```

No `npm install`, Docker, Pact Broker, or dedicated host is needed for the phase-0 proof.
The first command checks the machine, profile, files, and locked Postman-CS
dependency. The second runs the complete lower-environment gate and writes JUnit,
JSON, and checksums under `.contract-reports/`.

For the complete Harness proof, one credential-free customer config now carries
the Harness bindings and customer-owned Postman asset lock. It can generate either
the 18-variable Input Set or a complete versioned customer kit:

```bash
mkdir -p .contract-handoff
cp config/paypal-tpe-handoff.example.json .contract-handoff/config.json
# Replace every Harness, connector, namespace, Broker, and Postman placeholder.
npm run handoff:doctor
npm run handoff:prepare
npm run customer:package
```

These commands also need no `npm install`. The customer package contains a concise
start guide, local proof, import-ready pipeline and Input Set, production stages,
full-file checksums, a self-verifier, release provenance, third-party notices, and
a CycloneDX SBOM. Cloud-mutating Postman provisioning tools are excluded. Generated
bindings remain in the ignored `.contract-handoff/` directory and contain no
credential values, but they are customer-confidential operational metadata.

See [`CUSTOMER-HANDOFF-KIT.md`](docs/CUSTOMER-HANDOFF-KIT.md) for the exact contents,
verification model, and delivery workflow.

To adapt it, edit the single credential-free
[`paypal-contract-gate.config.json`](paypal-contract-gate.config.json). For the
five-minute handoff and live-service environment variables, see
[`PAYPAL-TPE-QUICKSTART.md`](PAYPAL-TPE-QUICKSTART.md).

The modular files in `harness/stages/` keep a PayPal application repository as
the primary pipeline checkout. Their first two steps use Harness's native
`GitClone` step to pull `postman-cs/paypal-pact-harness-cd` into
`.pact-harness-source`, then fail closed unless its full commit matches the
runtime input. The vendored flow in
[`docs/DOWNSTREAM-ADOPTION.md`](docs/DOWNSTREAM-ADOPTION.md) is retained only for
environments that cannot read the Postman-CS repository at runtime.

**Consumer engine source of truth.** This repo carries the engine source
(`src/`), the tests (`test/`), the build (`scripts/build-bundle.mjs` → `tools/pact-harness`),
the fixtures, the GitHub composite action, Harness stages, the Orders Spring Boot lower-
environment wrapper, and a seeded ledger. Application-route parity and rogue endpoint
detection vendor the exact comparator from the production
[`postman-cs/paypal-harness-postman-stages`](https://github.com/postman-cs/paypal-harness-postman-stages)
repository at the full commit and SHA-256 recorded in `postman-cs.lock.json`. CI
verifies that digest before executing it, with no runtime network dependency.

In the complete Harness pipelines, `cloneCodebase: true` checks out this repo as
the primary codebase. In the drop-in stages, a native additional-repository
`GitClone` step pulls the same repo without replacing PayPal's primary checkout.
Both paths attest the exact origin, full commit, portable CLI, and locked
Postman-CS comparator before contract work. See
[`harness/IMPORT.md`](harness/IMPORT.md#source-checkout-and-portable-cli-trust-boundary).

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
`/actuator/mappings`, cross-checks generated `/v3/api-docs`, uses Postman CLI 1.45.0 for
authenticated positive and negative cases, proves schema drift and rogue endpoints fail
closed, uploads JUnit/JSON plus the packaged CLI, and publishes an immutable image.

## Harness stages and pipelines

See [`harness/IMPORT.md`](harness/IMPORT.md):

- `harness/stages/consumer-contract-gate.yaml` — drop-in KubernetesDirect stage for an
  existing PayPal pipeline; it pulls this Postman-CS repo as an additional checkout
  and the first run is locked to the `lower` environment.
- `harness/contract-gate.lower.pipeline.yaml` — complete lower-environment Kubernetes
  import template with the Spring app as an ephemeral Background step.
- `harness/contract-gate.self-test.pipeline.yaml` — zero-secret Harness Cloud proof, usable
  while a Kubernetes delegate is unavailable.
- `harness/contract-gate.real-consumer.pipeline.yaml` — Postman-backed phase-0 shared-ledger
  shape with workspace-bound, canonical-digest-pinned consumer Collection and
  provider OAS inputs, retained as an offline/low-infrastructure demonstration.
- `harness/contract-gate.broker.pipeline.yaml` — complete lower-environment integration proof:
  Postman dual-OAS/static gates → Pact publish → official provider verification → Broker
  `can-i-deploy` (with an independently reviewed source SHA, explicit logical Pact
  branches, and no fake deployment or premature deployment record).

The complete component map and execution sequence are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

For PayPal's requested production CDC shape, use the five additional stage objects:

- `postman-oas-preflight.yaml` pulls each consumer and provider OAS from its exact
  single ROOT file, verifies workspace membership and its reviewed canonical
  digest, and runs the existing static BDC gate;
- `pact-consumer-publish.yaml` creates a fresh run directory and publishes only
  non-empty pacts produced there by executable consumer tests;
- `pact-provider-verify.yaml` runs official verification with selectors, provider
  states, pending/WIP pacts, and result publication;
- `pact-can-i-deploy.yaml` blocks an incompatible promotion; and
- `pact-record-deployment.yaml` updates Broker environment state only after the
  real deployment and Postman smoke checks succeed.

See [`docs/PACT-BROKER-RUNBOOK.md`](docs/PACT-BROKER-RUNBOOK.md) for the ownership
model, rollout, Harness inputs and secrets, failure triage, and learning path.

## Maintainers: develop / rebuild

```bash
npm install          # dev only (yaml, for tests + rebuilding the bundle)
npm test             # engine, ledger, topology, and supply-chain tests
npm run check        # determinism: golden pact matches its generator
npm run build:bundle # regenerate tools/pact-harness/ from src/ (what the pipelines run)
npm run package:bundle # produce the portable .tgz + SHA-256 release metadata in dist/
npm run test:packed    # extract the .tgz in a clean path and prove it needs no install
npm run test:adoption  # vendor into three temporary customer repos and prove the lifecycle boundary
npm run test:all       # full local release gate
```
The contract engine never needs `npm install` at runtime—it calls the committed
`tools/pact-harness` bundle. The explicit Postman behavioral steps install the exact
Postman CLI release into the non-root build workspace; maintainers use `npm install`
only for tests or rebuilding the static bundle. Retained Postman JSON, JUnit, and
text reporter artifacts are credential-redacted and re-sealed before publication.

## Layout

| Path | What |
| --- | --- |
| `src/`, `test/` | the engine source + its tests (the source of truth) |
| `scripts/build-bundle.mjs` | builds the install-free bundle from `src/` → `tools/pact-harness/` |
| `tools/pact-harness/` | the committed, install-free CLI bundle (what the pipelines call) |
| `paypal-contract-gate.mjs`, `paypal-contract-gate.config.json` | TPE-friendly entry point and single versioned profile |
| `PAYPAL-TPE-QUICKSTART.md` | clone-to-green handoff and live lower-service setup |
| `config/paypal-tpe-handoff.example.json`, `scripts/tpe/prepare-handoff.mjs` | one-file, credential-free Harness and Postman binding generator |
| `scripts/tpe/package-customer-kit.mjs` | versioned customer kit with demo/production separation, verifier, SBOM, and archive |
| `action.yml`, `.github/workflows/` | modular GitHub action and executable end-to-end proof |
| `demo/orders-spring/`, `k8s/` | Orders Spring Boot wrapper and optional standalone lower deployment |
| `config/` | subset selectors, contract policy, governed exceptions, and app/spec graph |
| `contracts/` | the git-backed ledger (pacts, providers, verifications, what's live in `production`) |
| `fixtures/` | real PayPal Orders specs (good + drifted) + consumer pacts/collections |
| `demo/demo.mjs` | the runnable demo (no Harness needed to see it work) |
| `harness/` | drop-in stage plus self-test, lower, and Postman-backed pipeline templates |
| `pact-cli.lock.json`, `scripts/install-pact-cli.mjs` | digest-locked official OSS Pact CLI used by production lifecycle stages |
| `docs/ARCHITECTURE.md` | complete system map, execution sequence, evidence flow, and ownership boundaries |
| `docs/SINGLE-REPOSITORY-HANDOFF.md` | exact one-repository Harness import, neutral runtime bindings, and remaining production responsibilities |
| `docs/PACT-BROKER-RUNBOOK.md` | Postman-first Pact CDC topology, operations, rollout, and learning guide |

## Actions vs Harness — the point

GitHub packages and validates the code, uploads evidence, and publishes the demo image.
Harness is the PayPal execution and promotion-control plane: its modular stage runs the same
bundle inside the existing Kubernetes pipeline and a red verdict blocks the downstream
promotion. Neither platform owns the contract logic. See
[`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) for the evidence map and
[`docs/CONSUMER-DRIVEN.md`](docs/CONSUMER-DRIVEN.md) for the recommended production evolution.
