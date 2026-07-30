# Import into Harness

The consumer contract capability is available as one modular Kubernetes stage and
three runnable pipeline shapes. No broker or server is required for the phase-0
gate: the consumer engine is the vendored bundle (`tools/pact-harness`) and the
route comparator is vendored from the real Postman-CS repository with a full commit
and SHA-256 lock. The build verifies provenance; pipeline runtime stays offline.

## A. Drop-in stage for an existing pipeline

Import `harness/stages/consumer-contract-gate.yaml` before the existing promotion
stage. Supply:

- the repository codebase connector;
- the KubernetesDirect connector and lower-environment namespace;
- a registry connector for the Node runner image;
- the lower-environment application, Actuator, and generated OpenAPI URLs;
- project secrets `paypal_contract_demo_token` and `paypal_postman_api_key`.

The first validation is locked to `environment_name=lower`. The stage publishes
consumer/audit/route/Postman JUnit, writes JSON for every module, and seals an
evidence checksum manifest.

The account-specific lower pipeline defaults to the POC collection synced into the
personal `Bi-Directional` workspace. For another account, run
`tools/pact-harness/scripts/postman/sync-cloud-collection.mjs` with the target
workspace ID, then replace `POSTMAN_COLLECTION_ID`.

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
2. Set the **codebase connector** to a git connector pointing at THIS repo
   (`paypal-pact-harness-cd`); leave runtime as **Cloud** (or point at your own
   KubernetesDirect infra).
3. **Run.** Three steps execute:
   - Immediate BDC gate (JUnit published under the run's **Tests** tab),
   - fleet `can-i-deploy` over the committed ledger (→ YES),
   - fail-closed proof (a drift release → the step goes RED on purpose if it *isn't* blocked).

## E. Future real-consumer Postman pipeline

Pulls the consumer collection + provider OAS from Postman, records into a **shared**
contracts repo, and gates on the fleet.

Secrets already used by this POC (project scope):
| Secret | Used for |
| --- | --- |
| `paypal_postman_api_key` | Postman CLI login, collection + Spec Hub access |
| `postman_cs_github_pat` | clone + push the optional shared contracts repo |

Pipeline inputs when you run: codebase connector (this repo), `CONSUMER_COLLECTION_UID`,
`PROVIDER_SPEC_ID`, `PROVIDER_VERSION` (the version live in the target env), `LEDGER_REPO`
(e.g. `github.com/danielshively-source/paypal-contracts`).

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
