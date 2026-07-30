# Import into Harness

The consumer contract capability is available as one modular Kubernetes stage and
three runnable pipeline shapes. No broker or server is required for the phase-0
gate: the consumer engine is the vendored bundle (`tools/pact-harness`) and the
route comparator is resolved from the real Postman-CS repository with a full commit
and SHA-256 lock.

## A. Drop-in stage for an existing pipeline

Import `harness/stages/consumer-contract-gate.yaml` before the existing promotion
stage. Supply:

- the repository codebase connector;
- the KubernetesDirect connector and lower-environment namespace;
- a registry connector for the Node runner image;
- the lower-environment application and route-inventory URLs.

The first validation is locked to `environment_name=lower`. The stage publishes
consumer BDC and bidirectional route-comparison JUnit.

## B. Lower-environment pipeline

`contract-gate.lower.pipeline.yaml` is the complete KubernetesDirect import shape.
It targets the Orders Spring wrapper at:

`http://orders-spring.paypal-contract-lower.svc.cluster.local:8080`

Deploy `k8s/orders-spring-lower.yaml` first, using the immutable image produced by
the GitHub workflow. Do not point the first run at production.

## C. Self-test pipeline

`contract-gate.self-test.pipeline.yaml` is the zero-secret Harness Cloud proof.
Run it when the Kubernetes delegate is not yet available. It proves:

- the current Orders consumer contract passes;
- the selected application/spec routes match;
- consumer-breaking drift is blocked;
- a deliberately injected rogue endpoint is blocked.

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

## E. Real-consumer Postman pipeline

Pulls the consumer collection + provider OAS from Postman, records into a **shared**
contracts repo, and gates on the fleet.

Secrets (project scope):
| Secret | Used for |
| --- | --- |
| `postman_service_pmak` | Postman CLI pull (collection + Spec Hub) |
| `ledger_git_token` | clone + push the shared contracts repo (write to it only) |

Pipeline inputs when you run: codebase connector (this repo), `CONSUMER_COLLECTION_UID`,
`PROVIDER_SPEC_ID`, `PROVIDER_VERSION` (the version live in the target env), `LEDGER_REPO`
(e.g. `github.com/danielshively-source/paypal-contracts`).

The gate is read-only w.r.t. your app source — it records only to the contracts repo and
never promotes/deploys. Recording a *deployment* runs from your promotion pipeline, after
a real deploy (one-liner at the bottom of the pipeline file).

## Parity with GitHub Actions

This repository's `.github/workflows/contract-gate.yml` runs the same bundle,
same locked Postman-CS comparator, same Orders subset, and same fail-closed proofs.
The GitHub job also starts the Spring Boot wrapper and gates its generated runtime
OpenAPI inventory.
