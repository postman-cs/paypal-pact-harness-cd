# Import into Harness

The consumer contract capability is available as modular Kubernetes stages and
runnable pipeline shapes. No broker or server is required for the phase-0 gate:
the consumer engine is the vendored bundle (`tools/pact-harness`) and the route
comparator is vendored from the real Postman-CS repository with a full commit and
SHA-256 lock. The production consumer-driven lifecycle uses an externally managed
OSS Pact Broker and the digest-locked official Pact CLI.

## Production stage order

The stages belong in the pipeline that owns each event; do not combine consumer
contract generation and provider verification into one provider-owned pipeline.

**Consumer repository:**

1. `stages/postman-oas-preflight.yaml`
2. the consumer's executable Pact test using its real client
3. `stages/pact-consumer-publish.yaml`
4. optional Postman CLI Collection checks

**Provider repository:**

1. start the provider under test and deterministic state handler
2. `stages/pact-provider-verify.yaml`
3. `stages/consumer-contract-gate.yaml` for Postman behavioral and route evidence

**Deployment pipeline:**

1. `stages/pact-can-i-deploy.yaml`
2. PayPal's existing deployment/promotion stage
3. required Postman CLI target-environment smoke Collection
4. `stages/pact-record-deployment.yaml`

See `docs/PACT-BROKER-RUNBOOK.md` for why each signal is separate and how to roll
it out from shadow mode to a blocking production gate.

For a single lower-environment integration run, import
`contract-gate.broker.pipeline.yaml`. It starts the authenticated demo provider,
pulls both OAS contracts from Postman, runs the existing static/provider gates,
publishes the seeded Pact, performs official provider verification, and ends with
Broker `can-i-deploy`. It intentionally does not deploy or call
`record-deployment`; the committed Pact is integration-test evidence and must be
replaced by consumer-repository executable Pact output in production.

## Source checkout and portable CLI trust boundary

Harness performs the Git checkout; the portable CLI does not clone its own source.
Every complete pipeline in this repository fixes `repoName` to
`paypal-pact-harness-cd`, enables Harness `cloneCodebase`, and runs
`scripts/ci/attest-harness-source.mjs` before any provider, Postman, Pact, or
deployment decision step. The attestation fails closed unless all of these are true:

- `origin` normalizes to `github.com/postman-cs/paypal-pact-harness-cd`;
- checked-out `HEAD` is the full SHA supplied by `<+codebase.commitSha>`;
- the committed portable bundle identifies itself as `pact-harness-bundle`; and
- its Postman-CS comparator repository, commit, provenance, and SHA-256 all match
  `postman-cs.lock.json`.

Create a repository-scoped GitHub connector whose URL is exactly
`https://github.com/postman-cs/paypal-pact-harness-cd.git`, with read access and
API access enabled for webhook triggers. Bind the pipeline's remaining
`connectorRef: <+input>` to that connector in a Harness Input Set or trigger.
An account-scoped connector is also supported because `repoName` is fixed and the
attestation independently verifies the full owner/repository identity.

## A. PayPal TPE drop-in stage

Import `harness/stages/consumer-contract-gate.yaml` before the existing promotion
stage. The contract inputs are no longer individual Harness variables. They live
in the reviewed `paypal-contract-gate.config.json` profile and the stage runs the
same command a developer runs locally:

```bash
node paypal-contract-gate.mjs verify --config paypal-contract-gate.config.json --clean
```

Supply only:

- the repository codebase connector;
- the KubernetesDirect connector and lower-environment namespace;
- a registry connector for the Node runner image;
- the lower-environment application, Actuator, and generated OpenAPI URLs; and
- project secrets `paypal_contract_demo_token` and
  `paypal_postman_service_account_pmak`.

The first validation is locked to `environment_name=lower`. The stage publishes
consumer/audit/route/Postman JUnit, writes JSON for every module, and seals an
evidence checksum manifest.

If the lower pipeline uses a Postman Cloud collection, sync the POC collection into
the shared team workspace by running
`tools/pact-harness/scripts/postman/sync-cloud-collection.mjs` with the target
workspace ID, then replace `POSTMAN_COLLECTION_ID`.

### Customer-owned primary checkout

The stage above deliberately attests that the primary checkout is this
Postman-CS repository. For an application pipeline whose primary checkout must
remain the PayPal repository, vendor the pinned bundle and import
`stages/consumer-contract-gate.vendored.yaml`. The full install, lock,
cross-platform byte-preservation, local proof, and update process are in
[`../docs/DOWNSTREAM-ADOPTION.md`](../docs/DOWNSTREAM-ADOPTION.md).

## B. Lower-environment pipeline

`contract-gate.lower.pipeline.yaml` is the complete KubernetesDirect import shape.
It starts the Orders Spring wrapper as an authenticated Harness Background step in
the same ephemeral Kubernetes CI pod, then calls it over `127.0.0.1`. This is the
canonical first proof because it needs no permanent namespace or ingress and leaves
no application workload behind.

For a long-lived lower environment, create `orders-spring-contract-auth` from the
same Harness secret and deploy `k8s/orders-spring-lower.yaml` using the immutable
image produced by GitHub. The drop-in stage can then target that ClusterIP service.
Do not point the first run at production.

## C. Self-test pipeline

`contract-gate.self-test.pipeline.yaml` is the zero-secret Harness Cloud proof.
Run it when the Kubernetes delegate is not yet available. It proves:

- the OAS security, negative response, and example audit passes;
- the current Orders consumer contract and all nine selected routes pass;
- governed exceptions validate;
- consumer-breaking BDC drift, schema diff, and a rogue endpoint are blocked.

This self-test is execution evidence for the stage logic, but it does not replace
the required lower-environment Kubernetes run.

## D. Legacy ledger proof

Runs GREEN with no secrets, against the committed fixtures + seeded `contracts/` ledger.
Good for a first run / demo.

1. Harness → your CI project → **Pipelines → + Create a Pipeline → Import From Git**
   (or **Create** then paste the YAML).
2. Set the **codebase connector** to a repository-scoped GitHub connector pointing
   at `https://github.com/postman-cs/paypal-pact-harness-cd.git`; leave runtime as **Cloud** (or point at your own
   KubernetesDirect infra).
3. **Run.** Three steps execute:
   - Immediate BDC gate (JUnit published under the run's **Tests** tab),
   - fleet `can-i-deploy` over the committed ledger (→ YES),
   - fail-closed proof (a drift release → the step goes RED on purpose if it *isn't* blocked).

## E. Phase-0 shared-ledger Postman pipeline

Pulls the consumer collection + provider OAS from Postman, records into a **shared**
contracts repo, and gates on the fleet. This demonstrates distributed ownership but
does not provide Broker selectors, pending/WIP pacts, or official provider matching.
Use the production stage order above for PayPal's requested CDC delivery.

Secrets already used by this POC (project scope):
| Secret | Used for |
| --- | --- |
| `paypal_postman_service_account_pmak` | Postman CLI login, collection + both Spec Hub workspace reads |
| `postman_cs_github_pat` | clone + push the optional shared contracts repo |
| `paypal_pact_broker_token` | Pact publication, verification results, deploy decisions, deployment records |
| `paypal_pact_provider_bearer_token` | Official verifier calls to the provider under test |

The self-contained lower Broker proof uses `paypal_contract_demo_token` for both
the demo provider and verifier so the values cannot diverge. The reusable provider
stage uses `paypal_pact_provider_bearer_token` for a real service-specific credential.

Pipeline inputs when you run: codebase connector (this repo), `CONSUMER_COLLECTION_UID`,
`PROVIDER_SPEC_ID`, `PROVIDER_VERSION` (the version live in the target env), `LEDGER_REPO`
(e.g. `github.com/postman-cs/paypal-contracts`).

The gate is read-only with respect to app source and never promotes/deploys. The
optional ledger write targets only a dedicated contracts repository. Production
service/spec details remain outside this Orders demo.

## Parity with GitHub Actions

This repository's `.github/workflows/contract-gate.yml` runs the same bundle,
same locked Postman-CS comparator, policy, exceptions, Orders subset, and fail-closed
proofs. GitHub also starts Spring Boot, gates authoritative Actuator mappings,
cross-checks generated OpenAPI, and runs Postman CLI positive/negative requests.

## Evidence retention

GitHub stores the complete JUnit/JSON evidence and portable CLI artifact for 30
days. Harness renders JUnit and retains execution logs under the account policy.
This account does not have a Harness Artifact Registry licence, so a native
`HarUpload` step is intentionally not included. Add an S3/GCS/JFrog upload step if
PayPal requires the Harness execution itself to persist the JSON files externally.
