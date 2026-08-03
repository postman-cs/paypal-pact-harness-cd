# POC engineering decisions

These decisions describe the current implementation. They are reversible, but a
change must keep the acceptance evidence in `docs/REQUIREMENTS.md`.

## D1 — Consumer-authored static BDC first

Consumers provide Pact v3, a consumer OAS, or a Postman collection with examples.
The bundle normalizes the input to Pact and statically verifies it against the
provider OAS. This is fast, deterministic, and valuable before provider code exists.

It is not full Pact-style CDC: a contract generated from saved examples does not
prove that the consumer's real client emitted or handled those messages. Critical
consumers should eventually author contracts from executable Pact tests.

## D2 — Keep provider conformance and consumer compatibility

The two gates answer different questions:

- selected OAS ↔ deployed route inventory catches missing and rogue implementation
  routes, gateway/deployment skew, and codegen escape hatches;
- consumer Pact ↔ provider OAS catches provider changes that break what consumers
  actually rely on.

OAS-first codegen reduces provider drift but does not make either question redundant.

## D3 — The first runtime proof is lower Kubernetes

The pure contract engine needs no box. End-to-end proof does: the authenticated
Spring Boot wrapper runs as a Background step beside the gate in one ephemeral
Harness KubernetesDirect pod in the existing lower K3s cluster. This avoids a
permanent POC namespace while still exercising the customer's Kubernetes execution
path. A digest-pinned manifest supports a persistent lower service later.
Production is not an allowed first target.

## D4 — One portable CLI bundle

`scripts/build-bundle.mjs` creates `tools/pact-harness`, which includes the complete
gate, all engine modules, inventory/Postman helpers, the YAML parser, and the
digest-verified Postman-CS comparator. `npm pack` turns it into a platform-agnostic
`.tgz`. Runtime requires Node 20 or newer, not a repository checkout or `npm install`.

## D5 — Dependency and supply-chain policy

The source dependency floor is Node standard library plus `yaml`. The Postman-CS
route comparator is fetched at build time from the real repository, full commit, and
SHA-256 lock, then vendored into the release. CI actions and container bases are
immutable-reference pinned where their ecosystems support it.

## D6 — Determinism

Transformers, audits, diffs, and verdicts are pure functions of versioned inputs.
Generated Pact fixtures are byte-stable. Clock use is limited to validating approval
and expiry timestamps in the mismatch-exception register.

## D7 — Type matching by default

Consumer response examples emit type matchers rather than brittle exact-value
matches. The deep schema validator still enforces required properties, enum/const,
formats, patterns, numeric/string/array constraints, and `additionalProperties`.

## D8 — Postman CLI first

Use exact Postman CLI 1.45.0 for login, collection execution, Cloud run history,
and JSON/JUnit reporting. Use the documented Postman API for Spec Hub definitions,
workspace-membership proof, collection export, and standalone collection upsert
where the CLI does not expose the required primitive. Secrets are passed by the
runner and never written into committed files.

## D9 — Actuator is authoritative

For Spring applications, `/actuator/mappings` is the authoritative runtime route
inventory. `/v3/api-docs` is a secondary cross-check. Gateway inventory and observed
traffic are optional additional evidence, not replacements for the application
inventory.

## D10 — Versioned subset and relationship graph

`config/subsets/*.json` selects the application-owned part of a larger spec.
`config/contract-topology.json` stores named application/spec edges. This supports
one-to-many and many-to-many estates without hardcoding a single service pair.

## D11 — Block with governed exceptions

Mismatch policy defaults to `block`. An exception is valid only with a ticket,
approver, approval timestamp, meaningful reason, environment scope, and future
expiry. Complete-results mode runs all modules before returning the final failure;
bail mode remains a one-flag choice.

## D12 — CI platform responsibilities

GitHub validates source, packages the portable bundle, produces retained evidence,
and publishes the immutable demo image. Harness runs the modular gate inside
PayPal's Kubernetes pipeline and owns the promotion decision. Both invoke the same
contract logic.

## D13 — Phase-0 deployment ledger

The optional cross-pipeline `can-i-deploy` state is a dedicated git-backed ledger:
Pacts, provider versions, verification results, and deployed-version records.
It is a low-infrastructure phase-0 option, not a claim of Pact Broker feature parity.
Use an OSS Pact Broker or PactFlow when selectors, pending/WIP pacts, webhooks, and
broker governance become requirements.

## D14 — One TPE profile and two commands

`paypal-contract-gate.config.json` is the reviewed, secret-free service profile.
`doctor` validates the runtime, every input, the lower-only safety lock, and the
Postman-CS provenance. `verify --clean` executes and seals the entire gate. Advanced
flags remain in the low-level bundle, but PayPal TPE onboarding does not depend on
them. CI proves the same path on Linux, Windows, and macOS at the Node 20 floor and
tests the extracted release in a clean directory whose path contains spaces.

## D15 — Postman-first production Pact lifecycle

The rebuilt static BDC, route, schema, and Postman Collection gates remain the
fast design/provider-conformance layer. Production CDC adds narrowly scoped,
separate open-source Pact stages: executable consumer publication, official
provider verification with states/selectors/pending/WIP, `can-i-deploy` before the
real PayPal deployment, and `record-deployment` only after deployment and required
Postman smoke checks succeed. Both OAS inputs are fetched from their declared
Postman workspaces and digest-sealed. The Git ledger remains phase-0 only.

## D16 — Harness owns checkout; source attestation runs first

The portable CLI is execution payload, not a Git client. Harness clones the
pipeline codebase through its GitHub connector with the repository name fixed to
`paypal-pact-harness-cd`. Before any contract or deployment-decision work, source
attestation verifies the full `postman-cs` repository identity, the exact Harness
commit SHA, the bundle package identity, and the locked comparator provenance and
digest. Wrong connectors, stale commits, incomplete bundles, and comparator
tampering therefore fail before customer APIs or the Pact Broker are contacted.
