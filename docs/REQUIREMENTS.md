# PayPal confirmed requirements and evidence map

This file is the acceptance contract for the repository. A green unit suite is
not treated as end-to-end evidence by itself.

| Confirmed requirement | Implementation/evidence |
| --- | --- |
| Every endpoint in the selected spec exists in the application | The digest-locked Postman-CS `compare-routes.mjs` comparator reports `missingInApp`; `config/subsets/orders-demo.json` defines the selected Orders surface. |
| Every application endpoint appears in the selected spec; explicit rogue detection | The same comparator reports `rogueInApp` and fails under `policy=block`. Both GitHub and Harness proofs deliberately inject a rogue route and require a non-zero result. |
| Compare an application with a selected subset of a spec | The subset is applied to both spec and application route sets. The composite action accepts `spec-subset`; the Harness stage accepts `subset_path`. |
| One-to-many and many-to-many application/spec relationships | `config/contract-topology.json` stores explicit graph edges. `src/contract-topology.mjs` validates them, and its tests exercise a 2×2 many-to-many graph. A pipeline instantiates the modular gate once per edge. |
| Contract testing is a modular stage in an existing Harness pipeline | `harness/stages/consumer-contract-gate.yaml` is one importable `stage:` object. It does not replace PayPal triggers, deployment, governance, or promotion stages. |
| First end-to-end validation runs in a lower environment | The Kubernetes stage refuses any first-run environment other than `lower`. `demo/orders-spring` and `k8s/orders-spring-lower.yaml` provide the lower-environment wrapper and service. |
| Postman modules: synchronization, contract testing, mismatch detection | Synchronization remains in the production Postman-CS stages; this repo adds consumer contract testing and selected-route mismatch detection. These are composed, not reimplemented. |
| Orders is the preferred complex demo API | All executable proofs use the pinned PayPal Orders v2 OAS and a three-operation selected subset. Orders remains a demo, not a claim about the production service. |
| PayPal testENV implements; Varun is the primary technical contact | Implementation ownership is recorded as PayPal testENV with Varun as primary technical contact. Jason is not treated as the current owner. |
| Spring Boot wrapper | `demo/orders-spring` exposes create, get, and capture Orders endpoints, Actuator health/mappings, and generated OpenAPI route inventory. |
| Harness stages on Kubernetes | The drop-in and lower pipeline use `KubernetesDirect`, Linux AMD64, an explicit registry connector, and the `paypal-contract-lower` namespace. |
| Postman CLI wherever practical | The real-consumer pipeline uses Postman CLI for Spec Hub pulls and the production Postman-CS quality stages use it for login, lint, collection execution, and JUnit. Raw API use is limited to collection export, where the CLI lacks an export primitive. |
| Dependencies from the real Postman-CS repository | Route comparison is fetched from `postman-cs/paypal-harness-postman-stages` at the full commit and SHA-256 in `postman-cs.lock.json`. Digest or repository mismatch fails before execution. |

## Required proof sequence

1. GitHub Action: build/test the Node engine and Spring wrapper.
2. GitHub Action: gate the running wrapper's generated `/v3/api-docs` inventory.
3. GitHub Action: prove consumer-breaking OAS drift and an injected rogue route both block.
4. Harness self-test: run the identical bundled engine and pinned comparator with JUnit.
5. Harness lower environment: run `consumer-contract-gate` on KubernetesDirect against the
   Orders wrapper service before any production-like environment.

Steps 4–5 require live Harness execution evidence. A missing/offline delegate is an
environment blocker, not a pass.
