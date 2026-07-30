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
Spring Boot wrapper runs in the existing lower Kubernetes cluster, and the Harness
stage executes in that cluster before promotion. Production is not an allowed first
target.

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

Use exact Postman CLI 1.44.0 for login, Spec Hub pull, collection execution, and
JSON/JUnit reporting. Use the documented Postman API only when no CLI primitive
exists, currently collection export. Secrets are passed by the runner and never
written into committed files.

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
