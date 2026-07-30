# Phase 0 — Decisions & pins

Locked engineering decisions for the build. Each is reversible but should change
only deliberately (a change here ripples through the emitted contracts).

> **Scope decision (2026-07-29) — static BDC, ZERO boxes.**
> Both sides come from OAS, so the cross-verify is pure computation and needs no box;
> it runs in the pipeline. The cross-team `can-i-deploy` system of record runs boxless
> too, as a **git-backed contract ledger** (D12). **No server, no database, no broker.**
> **Dropped:** dynamic replay (D2's opt-in leg, the matcher/`replay-verify`), the
> Anchorage/k8s deploy, the Postman mock/monitor planes (D8's dynamic role, D11's tiers
> 2–3, `pact-to-postman`), **and the OSS Pact Broker itself** (D3 — replaced by the D12
> ledger). The decisions below are annotated where this
> narrows them; the OSS-only / determinism / read-only / separate-action decisions are
> unchanged.

## D1 — Pact Specification **v3** as the interop target (first increment)

The transformer emits and the cross-verifier reads **Pact Specification v3**
(`"pactSpecification": { "version": "3.0.0" }`). Rationale: v3 is the most
universally supported interchange format across the Pact ecosystem, with a stable,
well-understood `matchingRules` model
(category → JSON-path → `matchers[]`). v4 adds interaction types, plugin config,
and comments we do not need yet; a v4 bump is an additive emitter change, not a
rearchitecture. **Pin:** `PACT_SPEC_VERSION = "3.0.0"` in `src/lib/pact.mjs`.

## D2 — Bi-Directional Contracts (BDC) first; the OAS **is** the provider contract

We do not run the provider to verify it. The provider side of every contract is
PayPal's existing OAS (the artifact they already design-first and codegen from).
Our cross-check verifies consumer pacts **against the OAS statically**.
This is the decision that makes the whole thing fit an OAS+codegen+Apigee shop.
~~Dynamic replay (vs a live/mocked provider) is a per-service opt-in (later phase).~~
**Dropped 2026-07-29** — with both sides from OAS, static BDC answers the question;
runtime replay is a different, optional guarantee that needs a box and is redundant here.

## D3 — OSS-only, **PactFlow-independent**, and now **broker-free**

Provider-contract cross-verification (consumer pact × OAS) has historically had
surface that lives in **PactFlow (commercial)** rather than the OSS Pact Broker. **We
own the cross-check ourselves** (`src/bdc-verify.mjs`) — a bounded, well-specified
function — so the capability never depends on a paid SaaS.

**Superseded 2026-07-29 (broker dropped entirely).** We originally planned to deploy
the open-source Pact Broker for storage / versioning / `can-i-deploy` / the network
graph. But since we already own the cross-check *and* both sides come from OAS, the
only thing the broker added was **shared state over time** — and that needs no server:
it lives in a **git-backed contract ledger** (D12). The OSS Broker was removed; the
ledger holds the same records in git and answers `can-i-deploy` as a pure CI read.
Net: **OSS-only, no PactFlow, no broker, no database.**

**RESOLVED (2026-07-29):** confirmed — BDC cross-verify is **PactFlow-commercial**;
the OSS Broker does not do it. So we own the cross-check (`bdc-verify.mjs`) and
PayPal gets BDC without a PactFlow licence. Full finding + sources in `THIRD-PARTY.md`.

## D4 — Dependency floor: Node stdlib + `yaml` only

EchoAtlas-free and near-zero-dep so PayPal can own it outright (mirrors the
provider-side harness, which carries `yaml` as its only real dep). `yaml` (MIT)
is used solely to parse OAS/collection YAML; everything else is Node stdlib.
No network, no telemetry, no empire packages.

## D5 — Determinism

`postman-to-pact` and every emitted artifact are pure functions of their inputs:
stable key ordering, no clock, no randomness, LF line endings. Same collection +
same OAS ⇒ byte-identical pact and byte-identical verdict. This is what lets a
`--check`-style gate and golden fixtures work.

## D6 — Read-only, no promotion

The `can-i-deploy` verdict advises and blocks; it never deploys, promotes, or
writes to PayPal's source. Same mutation policy as the provider-side harness.

## D11 — The pact gate is a **separate drop-in action**; the gate is box-free (static BDC)

**Separate action.** The consumer-driven pact gate ships as its own standalone
composite action (`action.yml`), one-stage-per-outcome exactly like the
`postman-cs` provider-side stages. PayPal drops it into their pipeline
independently, SHA-pinned; it never couples to the provider-side harness stages.
Both a GitHub composite action (`action.yml`) and a Harness stage
(`harness/stages/pact-bdc-gate.yaml`) are provided; same engine underneath.

**The gate needs no box.** Because both sides come from OAS, the verdict is
**BDC static** — consumer pact × provider OAS, computed in the pipeline, no provider,
no mock, no server. That is the whole gate.

~~Tiers 2–3 (dynamic replay against a Postman mock of the provider OAS / a live
provider)~~ **dropped 2026-07-29** — a different, optional runtime guarantee that needs
a box and is redundant for OAS-vs-OAS. The optional ledger `record-verification` step remains.

## D10 — End goal: a **Vercel end-to-end demo** alongside the postman-cs harness

The capstone deliverable is a Vercel-hosted demo that runs our consumer-driven BDC
**next to** the existing provider-side `paypal-harness-postman-stages` pipeline, so
one screen tells the whole story: *provider-driven gate ✅ GREEN (the codegen'd app
conforms to its OAS) while the consumer-driven BDC gate ❌ RED (a real consumer
breaks)*.

Design constraint this imposes on everything else: **the transform + verify core
must stay pure and browser/edge-safe** — no Node built-ins in `src/lib/pact.mjs`,
`src/lib/oas.mjs`, `src/postman-to-pact.mjs`, `src/oas-to-pact.mjs`,
`src/provider-verify.mjs`, `src/bdc-verify.mjs` (file/YAML IO lives only in
`load.mjs` / `cli.mjs`). Then the
Vercel app imports the same pure functions the CLI and Harness stage use — one
engine, three surfaces (CLI, Harness gate, web demo). Matches the estate's Pillar 1
(serverless) and the no-live-keys reality: the demo runs self-contained on bundled
fixtures (and pasted input), no server round-trip or secret required.

## D9 — Postman **CLI-first** for every Postman-native operation

Inherited verbatim from the provider-side harness: the **signed Postman CLI is the
execution/IO plane**. Wherever a Postman CLI primitive exists, we invoke it; we do
not hand-roll a raw Postman API call or a manual export. Our transformer and
cross-verifier are pure and operate on the artifacts the CLI produces.

- **Fetch the consumer collection** → `postman` CLI (login/discovery + export), not
  the raw API. `postman-to-pact` reads that exported collection JSON.
- **Pull the provider OAS** → `postman spec` (Spec Hub) via the CLI. `bdc-verify`
  reads that OAS.
- **Lint / run** (dynamic-CDC leg, dev-time) → `postman spec lint`, `postman
  collection run` — CLI primitives, JUnit out, exactly as the harness gate does.
- **Raw Postman API only** for lifecycle ops the CLI doesn't expose cleanly (asset
  upsert, mock creation), same carve-out the harness makes.

Thin wrappers under `scripts/postman/*` shell to `postman` and emit the artifact
our pure code consumes; the Harness stages call those wrappers. The CLI version is
runner-provided and reviewed (no `curl | sh`).

## D8 — Postman mocks: yes, but role-scoped (never for verification-from-consumer)

Postman mocks are leveraged, deliberately, in two roles — and forbidden in a third:

- ✅ **Consumer authoring + dev-time stand-in.** Teams keep expressing expectations
  as Postman collections with example responses (the surface they already use); a
  Postman mock off that collection gives them a live stand-in to build against. The
  *same* collection is the input to `postman-to-pact`, so the mock and the pact are
  two projections of one artifact — no duplicate source of truth.
- ✅ **Provider stand-in for the dynamic-CDC leg — generated from the provider OAS.**
  For services that opt into runtime replay, a Postman mock built from the
  **provider's OAS** is a valid alternative to Prism-on-Anchorage, keeping the mock
  plane inside Postman. The mock plane is pluggable (`prism` | `postman`), OAS-sourced.
- ⛔ **Never verify a consumer pact against a mock built from that consumer's own
  examples.** That is circular — the mock echoes the expectation, so it always
  passes and catches nothing. Verification is always against the provider side:
  the OAS (BDC, static) or an OAS-derived/real provider (dynamic).

Consequence for BDC (the default): the static cross-check uses **no mock at all** —
it is OAS × pact computed directly.

**Update 2026-07-29:** with the dynamic leg dropped, mocks no longer play any role in
verification. The Postman mock's only remaining use would be dev-time authoring
(a live stand-in for a consumer team building against the collection); the verification
path is OAS × pact, full stop.

## D12 — The `can-i-deploy` authority runs **in CI, boxless** — a git-backed ledger

The one thing a standing broker would give you that a single pipeline run can't is
**shared state over time**: the contract/verification history and *which version is
live in which environment*, so `can-i-deploy` can be answered across many consumers
and provider versions. That state has to persist *somewhere* — but it does not need a
server. We put it in **git**.

- **Ledger = committed files** (`src/lib/ledger.mjs` layout): `pacts/…`, `providers/…`,
  `verifications/…`, and the one mutable record, `environments/<env>/<pacticipant>.json`
  (which version is live where). A dedicated contracts repo/branch, not the app source.
- **`can-i-deploy` is a pure read** (`canIDeployLedger`): for the candidate version,
  every integration partner *currently deployed in the target environment* must have a
  passing verification against it. The algorithm a broker would run, as a pure read;
  zero infrastructure. Runs as a step in the action / Harness stage.
- **Recording is a file write + commit.** `record-verification` and `record-deployment`
  write records; `scripts/ledger-sync.mjs` commits and
  pushes with **rebase-retry** (`src/lib/git-retry.mjs`) — the one place concurrent
  pipelines contend, resolved the git-native way. Ledger writes touch distinct files,
  so rebases apply cleanly.
- **Read-only w.r.t. PayPal's source.** Recording writes only to the separate contract
  ledger repo; the gate never promotes or deploys. Marking a *deployment* is a one-liner
  PayPal runs from its own promotion step, after a real deploy.

This makes the entire capability — verify **and** `can-i-deploy` — a boxless CI
computation. There is nothing to run: no server, no database, no broker. The one CLI
`can-i-deploy` has two modes: `--ledger` (cross-fleet, git-backed) and `--oas`
(single-pair static).

## D7 — Matching policy: **type matchers by default**

Consumer expectations captured from Postman example responses are matched by
**type, not exact value** (a consumer needs "an integer `id`", not "`id == 42`").
Exact match is opt-in per field. This is what keeps generated contracts from
being brittle — the single most common way naive Postman→contract conversions
fail in practice.
