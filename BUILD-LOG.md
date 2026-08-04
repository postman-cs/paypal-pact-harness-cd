# Build and validation log

Last updated: 2026-08-04 (America/Los_Angeles)

This record separates supplied-demonstration validation from customer production
acceptance. A green toolkit or Orders demo proves the portable contract-testing
path; it does not claim a PayPal application deployment or a real consumer-owned
production Pact.

## Release under handoff

| Item | Value |
| --- | --- |
| Public repository | `https://github.com/postman-cs/paypal-pact-harness-cd` |
| Commit-pinned source release | [`v0.6.5`](https://github.com/postman-cs/paypal-pact-harness-cd/releases/tag/v0.6.5) |
| Authoritative source identity | The full **Reviewed commit** on the release page; the tag is a convenience reference and must resolve to that exact SHA |
| Maintained onboarding branch | `main` |

The public release contains generic source only. A configured customer kit is
generated from a checkout whose `HEAD` exactly equals the reviewed release commit,
then delivered through an approved access-controlled channel with its checksum
and delivery guide. It is never a public CI or release asset.

## Validation results

| Surface | Result | Evidence |
| --- | --- | --- |
| Last public `main` matrix before v0.6.5 hardening | PASS | [run 30891323552](https://github.com/postman-cs/paypal-pact-harness-cd/actions/runs/30891323552), commit `e855976f1e4d7ad0331657389883a094c69c289a` |
| Local v0.6.5 release-candidate gate | PASS | 195/195 tests plus topology/fixture checks, downstream adoption, portable bundle build/package, clean extraction, customer-kit integrity/tamper cases, and adversarial security tests |
| Operating systems | PASS on last public matrix | Ubuntu 24.04, macOS 14, and Windows Server 2022 with Node 20 |
| Spring lower proof | PASS | Digest-pinned Maven/Java wrapper, implementation routes, generated OpenAPI, positive/negative Postman cases, schema drift, and rogue-route rejection |
| Security scanners | PASS on equivalent reviewed tree | Wiz data, IaC, SAST, secret, software-management, and vulnerability checks passed on [PR #7](https://github.com/postman-cs/paypal-pact-harness-cd/pull/7) head `261b29d…`; its Git tree is content-identical to merge commit `e855976…` |
| Credentialed Postman integration | PASS on earlier commit | [run 30866354686](https://github.com/postman-cs/paypal-pact-harness-cd/actions/runs/30866354686), commit `f4690e3…`: live workspace assets plus provider Collection, 11 requests and 12 assertions. This proves the path, not a production customer acceptance. |
| Harness supplied Orders demonstration | PASS three consecutive times on `v0.6.4` | [Build 26](https://app.harness.io/ng/account/MqRO9-E1S3KCCbydo-lPPg/module/ci/orgs/default/projects/default_project/pipelines/paypal_postman_pact_broker_lower/executions/3iHpgvD1RqGIQ5zFqQ6R3w/pipeline), [Build 27](https://app.harness.io/ng/account/MqRO9-E1S3KCCbydo-lPPg/module/ci/orgs/default/projects/default_project/pipelines/paypal_postman_pact_broker_lower/executions/YWtM2eHQQsKlq6PhI6YNSw/pipeline), and [Build 28](https://app.harness.io/ng/account/MqRO9-E1S3KCCbydo-lPPg/module/ci/orgs/default/projects/default_project/pipelines/paypal_postman_pact_broker_lower/executions/doxFoZu1QVu55-7k4t-lGw/pipeline) attested exact commit `6c2bd1c7c37bdfdcaf1fda12a8b9b7d92649ef97`; each completed 1/1 stages successfully. Build 28 is the canonical latest of that set. Harness links require account access. |
| PayPal production CDC/customer acceptance | **NOT RUN — OUT OF SCOPE** | Requires real consumer-generated Pacts, the exact PayPal provider build, deterministic provider states, deployment, target-environment Postman smoke tests, and post-deployment recording |

Builds 26–28 each passed checkout, source/portable-CLI attestation, Postman
dual-OAS and static BDC, provider conformance, provider Collection execution,
seeded consumer Pact publication, official provider verification, and a non-empty
Broker `can-i-deploy` decision. They did not deploy or record a deployment.

Historical Build 24 validated v0.6.3. Build 25 was an empty-input API probe and is
excluded from acceptance evidence.

CI-produced portable bundle: `pact-harness-bundle-0.6.5.tgz`, SHA-256
`41d747326a25fb0787abd0542fe9065f7f8ffa7c89e76b89a17b37ca9a8b7fe1`.
It is contained in the time-limited `contract-engine-evidence` Actions artifact;
it is not a configured customer kit and is not attached to the GitHub release.

## Canonical Postman demonstration evidence

The checked-in binding is machine-classified as a Postman-CS-owned `public-demo`
asset, explicitly not customer-owned, with a review expiry. Public Actions upload
only summarized evidence and JUnit; raw OAS, Collections, and generated Pacts stay
on the ephemeral runner.

| Asset | Canonical SHA-256 |
| --- | --- |
| Consumer OAS | `f1360361b193c9f4680e6d9ae183e3e4a3f2fcdfbe36c103d972911bc6cb50d2` |
| Consumer Collection | `c3540d6af7e4e7e0b300064455ea3d87447ff3ae056264d06209d29b2b2c97ca` |
| Provider OAS | `859d924aa5e1c96ba1eda467f564be571cf7ad494ac0814460110ba6f751a757` |
| Provider Collection | `4de8a4c22ce8d04dc673544905f693ae4945bb2970376ef6305a9e888ff191d9` |

Runtime retrieval fails closed on workspace-membership, classification, approval,
or canonical-content drift.

## Reproduce the install-free proof

Requirements: Git and Node 20 or newer.

```bash
git clone --branch v0.6.5 --single-branch \
  https://github.com/postman-cs/paypal-pact-harness-cd.git
cd paypal-pact-harness-cd
git rev-parse HEAD
# Compare the full SHA with the Reviewed commit on the v0.6.5 release page.
node paypal-contract-gate.mjs doctor
node paypal-contract-gate.mjs verify --clean
```

Expected final line:

```text
[PASS] PayPal contract gate (lower)
```

Maintainers reproduce the complete source gate with:

```bash
npm ci
npm run test:all
```

## Harness acceptance checklist

1. Import `harness/contract-gate.broker.pipeline.yaml` into the customer Harness
   project or use the generated customer-scoped copy.
2. Bind the read-only GitHub connector to this exact public repository.
3. Select tag `v0.6.5`; independently copy the release page's reviewed full SHA
   into `REVIEWED_SOURCE_COMMIT`.
4. Supply the registry connector, Kubernetes connector/namespace, both Postman
   workspace and Spec bindings, provider Collection binding, logical Pact branches,
   and the stable Broker hostname approval through the generated Input Set.
5. Create only the documented Harness secret references; never paste credentials
   into pipeline or Input Set YAML.
6. Use a stable operator-approved HTTPS Pact Broker. The handoff generator rejects
   tunnel, loopback, private/link-local, reserved, single-label, and unapproved hosts.
7. Confirm `Consumer first Broker` passes every required step and retains its
   customer-approved JUnit, JSON, provenance, and checksum evidence.

Production adoption still requires executable Pact tests in each real consumer,
deterministic provider states, the exact provider build under test, a deployment
gate before promotion, Postman smoke tests after deployment, and
`record-deployment` only after those actions succeed.
