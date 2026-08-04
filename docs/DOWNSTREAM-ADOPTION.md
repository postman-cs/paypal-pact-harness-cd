# PayPal TPE downstream adoption

This is the offline-mirror model for a PayPal environment that cannot read the
Postman-CS repository at runtime. The preferred drop-in model is now the modular
stage set under `harness/stages/`: it preserves the PayPal-owned primary checkout,
uses Harness's native `GitClone` step for the additional
`postman-cs/paypal-pact-harness-cd` checkout, and attests its full commit before
work. Use the vendored flow below only when that connector-based read is not
available.

## 1. Acquire a commit-pinned toolkit revision

Clone the versioned toolkit release and verify the full commit supplied by
Postman. Do not use a floating branch in a customer pipeline.

```bash
git clone --branch v0.6.5 --single-branch \
  https://github.com/postman-cs/paypal-pact-harness-cd.git
cd paypal-pact-harness-cd
git rev-parse HEAD # compare with the Reviewed commit on the v0.6.5 release page
node scripts/ci/attest-harness-source.mjs \
  --expected-commit <REVIEWED_V0_6_5_COMMIT>
```

The default branch is the maintained onboarding surface. Customer pipeline runtime
bindings must use a versioned tag and its independently reviewed full commit. The
full commit is the authoritative identity; a moved tag fails closed.

## 2. Vendor the portable bundle into the customer repository

Run this from the attested toolkit checkout:

```bash
node scripts/vendor-pact-harness.mjs \
  --expected-commit <FULL_POSTMAN_CS_COMMIT> \
  --target /path/to/customer-repo/.ci/pact-harness \
  --lock /path/to/customer-repo/.ci/pact-harness.lock.json \
  --verifier /path/to/customer-repo/.ci/verify-pact-harness.mjs
```

Commit all three outputs. The lock records the exact Postman-CS repository and
commit plus a deterministic SHA-256 over every regular file in the portable
bundle. The verifier lives outside the payload and rejects missing, modified,
extra, symlinked, case-colliding, or non-portable files.

Add this to the customer repository's `.gitattributes` before committing so Git
does not rewrite the locked bytes on Windows:

```gitattributes
/.ci/pact-harness/** -text
/.ci/pact-harness.lock.json text eol=lf
/.ci/verify-pact-harness.mjs text eol=lf
```

Protect those paths with the customer repository's CODEOWNERS and branch rules.
The final trust boundary is code review: anyone allowed to change the bundle,
lock, verifier, and pipeline together can also remove the gate.

## 3. Prove the customer checkout locally

Place the service-specific profile and inputs in the customer repository, then
run from that repository root:

```bash
node .ci/verify-pact-harness.mjs \
  --bundle .ci/pact-harness \
  --lock .ci/pact-harness.lock.json
node .ci/pact-harness/paypal-contract-gate.mjs doctor \
  --config paypal-contract-gate.config.json
node .ci/pact-harness/paypal-contract-gate.mjs verify \
  --config paypal-contract-gate.config.json \
  --clean
```

Configuration and contract paths resolve from the customer repository root. The
runtime engine resolves from `.ci/pact-harness`, requires no `npm install`, and
validates the locked Postman-CS route comparator before use.

## 4. Import the customer-owned Harness stage

Import `harness/stages/consumer-contract-gate.vendored.yaml` into the application
pipeline. `cloneCodebase: true` now checks out the customer repository. The stage:

1. verifies the full vendored bundle and runs `doctor`;
2. runs the config-driven lower service gate;
3. runs an explicitly supplied local or Postman Cloud collection; and
4. seals the bundle attestation with the JSON/JUnit evidence.

There is no fallback to an Orders demo collection in this stage. Set
`postman_collection_path` for a reviewed local Collection. For Cloud mode, set
`postman_collection_id`, `postman_collection_workspace_id`, and the reviewed
canonical digest in `postman_collection_sha256`; the gate proves all three before
running a sealed local snapshot.

## 5. Reproduce the downstream acceptance proof

Maintainers run:

```bash
npm run test:adoption
```

The test creates separate temporary consumer, provider, and deployment Git
repositories, vendors the bundle into each, and proves:

- customer-repository execution and evidence generation;
- a compatible provider is deployable;
- a consumer-breaking provider is blocked;
- only the compatible provider is recorded in `lower`; and
- a tampered downstream bundle fails attestation.

Evidence is written to `.contract-reports/downstream-adoption/`.

On a clean checkout, the adoption proof source-attests the actual Postman-CS
checkout at its current `HEAD` before vending. A maintainer's dirty working tree
cannot produce source-attestation evidence. In that case the script labels the
run `functional-snapshot-not-source-attestation`, exercises the uncommitted
functionality separately, and records `sourceAttested: false`. CI therefore
tests the production attestation path from the real clean checkout, while local
pre-commit runs cannot masquerade as trusted source provenance.

This is deliberately labeled **phase 0: static BDC plus Git ledger**. It proves
the delivery boundary and deployment decision semantics, but it is not a
substitute for executable consumer Pact tests, a live OSS Pact Broker, official
provider-state verification, a real PayPal deployment, or a target-environment
Postman smoke run. Those phase-1 dependencies remain external inputs described
in `docs/PACT-BROKER-RUNBOOK.md`.
