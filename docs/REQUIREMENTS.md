# PayPal requirements and executable evidence map

This is the acceptance contract for the Orders v2 proof of concept. A green unit
suite alone is not end-to-end evidence.

## Confirmed requirements

| Requirement | Implementation and evidence |
| --- | --- |
| Every selected spec endpoint exists in the application | The digest-locked Postman-CS comparator reports `missingInApp`. GitHub and Harness use `config/subsets/orders-demo.json` against authoritative Spring Actuator mappings. |
| Every application endpoint exists in the selected spec; explicit rogue detection | The comparator reports `rogueInApp` and fails under `policy=block`. Both CI systems inject `DELETE /v2/checkout/orders/{id}/internal` and require it to be blocked. |
| Compare an application with a selected subset of a spec | The subset selector is applied to both route sets. It supports path prefixes, methods, explicit operations, and exclusions. |
| One-to-many and many-to-many application/spec relationships | `config/contract-topology.json` stores named relationship edges, subset, policy, and exception register. Validation tests exercise a 2×2 graph. Instantiate one modular stage per edge. |
| Contract testing is modular inside an existing Harness pipeline | `harness/stages/consumer-contract-gate.yaml` is one importable `stage:` object. It does not own PayPal triggers, deployment, approval, or promotion. |
| Consumer-driven direction | Consumer-owned Pact, OAS, or Postman examples are normalized to Pact and checked against the provider OAS. This is static BDC, not a claim of full Pact CDC; see `docs/CONSUMER-DRIVEN.md`. |
| First end-to-end validation is lower-environment only | The Harness stage rejects an environment other than `lower`. The demo wrapper and Kubernetes namespace are explicitly labeled lower. |
| Postman modules: synchronization, contract testing, mismatch detection | Postman remains the artifact and execution plane; this bundle adds consumer contract/schema verification, while the exact Postman-CS comparator provides bidirectional mismatch detection. |
| Orders is the complex demo API | The executable proof selects all nine Orders v2 operations. It is a demo contract, not a claim about a PayPal production service. |
| PayPal testENV implements; Varun is primary technical contact | Ownership metadata names PayPal testENV and Varun. Jason is not named as the current owner. |
| Spring Boot wrapper | `demo/orders-spring` uses Java 21 and Spring Boot, exposes all nine selected operations, Actuator mappings, generated OpenAPI, health probes, and bearer authentication. It is vanilla Spring because PayPal's private wrapper is outside this POC's supplied inputs. |
| Harness CI stages run on Kubernetes | The drop-in and lower pipelines use `KubernetesDirect`, Linux AMD64, the private `paypal-contract-lower` namespace, and a ClusterIP service. |
| Postman CLI wherever practical | CI installs exact `postman-cli@1.44.0`. It runs positive and negative lower-environment cases with JSON/JUnit reporters and can publish Cloud run history when a collection ID is supplied. Raw API use is limited to collection export, for which the CLI has no export primitive. |
| Dependencies come from real Postman-CS | Build time fetches `postman-cs/paypal-harness-postman-stages` at the full commit and SHA-256 in `postman-cs.lock.json`; the portable bundle vendors that verified file. |

## Closed design questions

| Topic | Decision |
| --- | --- |
| Schema diffs, negative cases, security, examples | `oas-diff` blocks conservative selected-surface breaking changes. `oas-audit` requires operation IDs, security, success and negative responses, and valid examples. BDC validates required parameters/bodies and deep request/response schemas. |
| Authoritative route inventory | Spring Actuator mappings are authoritative. Generated OpenAPI is an independent secondary cross-check. Optional gateway inventory and runtime traffic endpoints can be collected without changing the gate interface. |
| App-to-spec-subset format | Versioned JSON selector at `config/subsets/orders-demo.json`; relationship edges reference it from the topology file. |
| Mismatch policy | Block by default. Exceptions require kind/method/path, meaningful reason, ticket, approver, approval timestamp, future expiry, and environment scope. The committed register is empty. |
| Bail versus complete results | Default action/stage mode is complete results so every module reports. Omitting `--complete-results` provides fail-fast/bail behavior. |
| Evidence destinations | Harness receives JUnit. Both runners produce task JSON, aggregate JSON/JUnit, an inventory manifest, and an evidence checksum manifest. GitHub stores the complete evidence and portable bundle for 30 days. A Harness Artifact Registry upload is not configured because this account has no HAR licence; an external object-store connector can be added without changing report generation. |
| Postman Cloud run history | The wrapper logs in and uses the Cloud collection ID when `POSTMAN_COLLECTION_ID` is supplied. Local file runs still produce JSON/JUnit but, per Postman behavior, do not create Cloud history. |
| Auth and test-data safety | Business routes require a bearer secret. CI injects an ephemeral environment file with mode `0600`, omits request/response headers and bodies from JSON, deletes the environment file, uses only synthetic data, and keeps the demo stateless. |
| Cleanup and retries | No durable order/payment/customer data is created. Application shutdown is graceful. Inventory fetches use bounded timeout, exponential backoff, redirect denial, and JSON validation. |
| Kubernetes network constraints | The service is ClusterIP-only. NetworkPolicy permits ingress only from the lower namespace and denies application egress. Service-account token mounting, privilege escalation, Linux capabilities, and writable root filesystem are disabled. |
| Evidence retention | GitHub evidence is explicitly retained 30 days. The topology records the same target. Harness JUnit/log retention follows the account policy. |

## Required proof sequence

1. Local: 51 engine, topology, schema, security, route, exception, retry, and
   supply-chain tests pass.
2. Packed CLI: extract the `.tgz` outside the repository and run the complete gate
   without `npm install`.
3. GitHub: build/test Spring, start it with a secret, collect Actuator and generated
   OpenAPI inventories, run the complete gate, run Postman CLI positive/negative
   checks, prove drift and rogue routes block, upload evidence, and publish an
   immutable image.
4. Harness Cloud: run the identical bundle and fail-closed proofs with JUnit.
5. Harness Kubernetes: deploy the immutable image and secret to the existing
   lower cluster, then run `consumer-contract-gate` on KubernetesDirect.

The PayPal production service/spec revision and private Spring wrapper are deliberately
outside this POC's acceptance scope because PayPal did not supply them.
