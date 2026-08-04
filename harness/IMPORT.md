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
2. `stages/pact-consumer-publish.yaml`, configured with the consumer's executable
   Pact test command using its real client
3. optional Postman CLI Collection checks

The publish stage creates `pacts_path`, exports that exact path to the executable
consumer test as `PACT_OUTPUT_DIR`, and publishes it in the same Harness CI stage.
Supply a new, workspace-relative run directory for every execution, for example
`pacts/<+pipeline.executionId>`; the stage refuses a pre-existing directory rather
than deleting or trusting its contents. The consumer command must write its Pact
files directly to `PACT_OUTPUT_DIR`. Publication fails if the command is a no-op,
if no Pact JSON is produced, or if any Pact has zero executable interactions.
This same-stage contract is required because Harness CI workspaces do not cross
stage boundaries unless the customer adds an explicit artifact handoff.

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

For a single-repository lower-environment integration run, import
`contract-gate.broker.pipeline.yaml` directly from
`postman-cs/paypal-pact-harness-cd`. The codebase connector selects this repository;
the pipeline does not clone a customer application or a second utility repository.
It starts the authenticated demo provider, pulls both OAS contracts from Postman,
runs the static/provider gates and approved provider Collection, publishes the
seeded Pact, performs official provider verification, and ends with Broker
`can-i-deploy`.

"Single repository" describes the supplied code, not a zero-configuration hosted
service. PayPal must bind its own read-only GitHub connector, container-registry
connector, Kubernetes connector/namespace, Postman workspaces, Pact Broker, and
secret references. No connector name tied to Postman infrastructure is committed.
The template exposes one shared `CONTAINER_REGISTRY_CONNECTOR`, one
`KUBERNETES_CONNECTOR`, and one `KUBERNETES_NAMESPACE` input instead of prompting
for a connector on every workload step.

The integration proof intentionally does not deploy or call `record-deployment`;
the committed Pact is seeded integration evidence and must be replaced by
consumer-repository executable Pact output in production.
The complete input inventory and production handoff boundary are in
`docs/SINGLE-REPOSITORY-HANDOFF.md`.

The complete Broker proof requires three identity inputs that are deliberately
independent of the Harness trigger shape:

- `REVIEWED_SOURCE_COMMIT`: the separately reviewed full SHA expected at `HEAD`;
- `CONSUMER_PACT_BRANCH`: the logical consumer branch recorded in the Broker; and
- `PROVIDER_PACT_BRANCH`: the logical provider branch used by verifier selectors.

Set these values explicitly for branch, tag, pull-request, and manual runs. The
selected Harness build ref only locates the checkout; it is not an approval signal,
application version, or source of Pact branch metadata.

The proof also requires `PROVIDER_COLLECTION_UID`,
`PROVIDER_COLLECTION_WORKSPACE_ID`, and
`PROVIDER_COLLECTION_CANONICAL_SHA256`. The runner proves workspace membership and
canonical content before executing a sealed snapshot against the lower provider.
Provider JUnit must contain at least one successful, non-skipped case, and
`can-i-deploy` must return a nonempty matrix with at least one success and no failed
or unknown checks. Empty or vacuously successful evidence is rejected.

## Source checkout and portable CLI trust boundary

Harness performs every Git checkout; the portable CLI never authenticates to or
clones Git by itself. Every complete pipeline in this repository fixes `repoName` to
`paypal-pact-harness-cd`, enables Harness `cloneCodebase`, and runs
`scripts/ci/attest-harness-source.mjs` before any provider, Postman, Pact, or
deployment decision step. The attestation fails closed unless all of these are true:

- `origin` normalizes to `github.com/postman-cs/paypal-pact-harness-cd`;
- checked-out `HEAD` is the independently supplied full SHA (the complete Broker
  proof uses `REVIEWED_SOURCE_COMMIT`; other templates use their documented
  immutable commit input);
- the committed portable bundle identifies itself as `pact-harness-bundle`; and
- its Postman-CS comparator repository, commit, provenance, and SHA-256 all match
  `postman-cs.lock.json`.

Create a repository-scoped GitHub connector whose URL is exactly
`https://github.com/postman-cs/paypal-pact-harness-cd.git`, with read access and
API access enabled for webhook triggers. Bind the CI codebase connector input to
that connector. Bind `CONTAINER_REGISTRY_CONNECTOR` to the connector that can pull
the digest-pinned Node and Maven images, and bind `KUBERNETES_CONNECTOR` to the
customer's Harness delegate-backed Kubernetes connector. An account-scoped GitHub
connector is also supported because `repoName` is fixed and the attestation
independently verifies the full owner/repository identity.

Every runtime stage under `harness/stages/` except the explicitly offline
`consumer-contract-gate.vendored.yaml` uses that connector as an additional native
`GitClone` step. It clones only
`postman-cs/paypal-pact-harness-cd` to `.pact-harness-source`, while the PayPal
application repo remains the pipeline codebase. Bind these three stage inputs:

- `harness_source_connector`: the read-only Postman-CS GitHub connector;
- `harness_source_ref`: the approved versioned release tag supplied by Postman-CS;
- `harness_source_commit`: the exact full 40-character commit SHA expected at that ref.

For these additional-clone steps, use an account-level GitHub connector whose
credential is fine-grained to read only this repository; the fixed full
`repoName: postman-cs/paypal-pact-harness-cd` removes repository selection from
the runtime form. A repository-scoped connector may be used only after the
Harness editor confirms the fixed `repoName` is accepted for that connector type.

The second step attests the additional checkout before any Postman, Pact, provider,
or deployment decision executes. A moved tag fails closed against the separately
reviewed full commit. Never use a floating branch here: an older approved run must
remain reproducible after development advances.

## A. PayPal TPE drop-in stage

Import `harness/stages/consumer-contract-gate.yaml` before the existing promotion
stage. The contract inputs are no longer individual Harness variables. They live
in the PayPal application repository's reviewed `paypal-contract-gate.config.json`
profile. The toolkit remains in the additional checkout, while the command runs
from the customer repository root so paths cannot fall back to toolkit demos:

```bash
node .pact-harness-source/paypal-contract-gate.mjs verify \
  --config paypal-contract-gate.config.json --clean
```

Supply only:

- the repository codebase connector;
- the KubernetesDirect connector and lower-environment namespace;
- a registry connector for the Node runner image;
- the lower-environment application, Actuator, and generated OpenAPI URLs;
- the real application Collection path, or its Postman Cloud Collection UID,
  expected workspace ID, and reviewed canonical SHA-256 plus the explicit
  `postman_cloud` switch; and
- project secrets `paypal_contract_demo_token` and
  `paypal_postman_service_account_pmak`.

The first validation is locked to `environment_name=lower`. The stage publishes
consumer/audit/route/Postman JUnit, writes JSON for every module, and seals an
evidence checksum manifest.

There is no fallback to a toolkit demo profile or Collection. If the lower pipeline
uses a Postman Cloud collection, sync the customer Collection into the shared team
workspace by running
`tools/pact-harness/scripts/postman/sync-cloud-collection.mjs` with the target
workspace ID, then supply the returned UID as `postman_collection` and set
`postman_cloud=true`. Also supply the workspace as
`postman_collection_workspace_id` and the sync output's canonical digest as
`postman_collection_sha256`. The runtime rechecks both before executing a sealed
snapshot. For a customer-repository Collection path, set `postman_cloud=false`.

### Offline mirror exception

The normal stage keeps the PayPal application repository as primary and pulls
this Postman-CS repo as a second, connector-authenticated checkout. Only when the
runtime cannot read Postman-CS should PayPal vendor the pinned bundle and import
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
| `paypal_pact_broker_password` | OSS Broker basic-auth password for publication, verification results, deploy decisions, and deployment records |
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
