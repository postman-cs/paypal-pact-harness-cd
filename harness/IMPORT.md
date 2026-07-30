# Import into Harness

Two pipelines, both here as YAML you import into a Harness CI project. No broker, no
server — the engine is the vendored bundle (`tools/pact-harness`) and the ledger is a git repo.

## A. `contract-gate.pipeline.yaml` — the self-contained proof (zero secrets)

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

## B. `contract-gate.real-consumer.pipeline.yaml` — the production shape

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

`paypal-pact-actions` runs the identical flow via `.github/workflows/contract-gate.yml`.
Same bundle, same ledger, same verdicts — only the runner differs.
