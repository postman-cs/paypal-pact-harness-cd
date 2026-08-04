# Build and validation log

Last updated: 2026-08-04 (America/Los_Angeles)

This record separates source validation from customer-environment acceptance. A
green source build proves the portable toolkit. It does not claim that a PayPal
application has been deployed or that a real consumer has published a production
Pact.

## Release under handoff

| Item | Value |
| --- | --- |
| Public repository | `https://github.com/postman-cs/paypal-pact-harness-cd` |
| Source release | [`v0.6.4`](https://github.com/postman-cs/paypal-pact-harness-cd/releases/tag/v0.6.4) |
| Reviewed source commit | `6c2bd1c7c37bdfdcaf1fda12a8b9b7d92649ef97` |
| Maintained onboarding branch | `main` |

The release has no configured customer-kit assets. GitHub supplies the normal
source archives; the configured kit is generated separately and delivered only
through an approved access-controlled channel with its adjacent SHA-256 receipt.

## Validation results

| Surface | Result | Evidence |
| --- | --- | --- |
| Release-tag GitHub matrix | PASS | [`v0.6.4` run 30889664175](https://github.com/postman-cs/paypal-pact-harness-cd/actions/runs/30889664175) |
| Post-release `main` matrix | PASS | [run 30890486507](https://github.com/postman-cs/paypal-pact-harness-cd/actions/runs/30890486507) |
| Local release gate | PASS | `npm run test:all`: 188/188 tests, topology/fixture checks, downstream adoption, bundle build/package, clean extraction, and tamper rejection |
| Operating systems | PASS | GitHub jobs passed on Ubuntu 24.04, macOS 14, and Windows Server 2022 with Node 20 |
| Spring lower proof | PASS | Digest-pinned Maven/Java wrapper, implementation routes, generated OpenAPI, positive/negative Postman cases, drift, and rogue-route rejection |
| Security scanners | PASS | Wiz data, IaC, SAST, secret, software-management, and vulnerability checks on the latest main run |
| Live Postman workspace readback | PASS | Both declared workspaces, two OAS documents, two Collections, workspace membership, and all four canonical digests were revalidated; both static compatibility reports passed 2/2 interactions |
| Harness end-to-end integration | PASS on release `v0.6.3` | [Build 24](https://app.harness.io/ng/account/MqRO9-E1S3KCCbydo-lPPg/module/ci/orgs/default/projects/default_project/pipelines/paypal_postman_pact_broker_lower/executions/GKx25SyeTBu3IamOCZNCcA/pipeline): GitHub checkout, Postman OAS pull, static/provider gates, provider Collection, Pact publication, official provider verification, and Broker `can-i-deploy` |
| Harness `v0.6.4` acceptance | PENDING | Requires an authenticated Harness operator to submit the complete runtime Input Set. [Build 25](https://app.harness.io/ng/account/MqRO9-E1S3KCCbydo-lPPg/module/ci/orgs/default/projects/default_project/pipelines/paypal_postman_pact_broker_lower/executions/7U1r_Zi4QumsdFrXy4pwhw/pipeline) was an empty-input API probe and is excluded from acceptance evidence. |

The GitHub workflow intentionally skips the live Postman job on ordinary pushes;
the read-only Postman validation above was run separately with the approved service
account. The Harness pipeline owns the provider Collection and Broker lifecycle
proof.

## Canonical Postman evidence

| Asset | Canonical SHA-256 |
| --- | --- |
| Consumer OAS | `f1360361b193c9f4680e6d9ae183e3e4a3f2fcdfbe36c103d972911bc6cb50d2` |
| Consumer Collection | `c3540d6af7e4e7e0b300064455ea3d87447ff3ae056264d06209d29b2b2c97ca` |
| Provider OAS | `859d924aa5e1c96ba1eda467f564be571cf7ad494ac0814460110ba6f751a757` |
| Provider Collection | `4de8a4c22ce8d04dc673544905f693ae4945bb2970376ef6305a9e888ff191d9` |

The checked-in binding is
[`config/postman-workspace-simulation.json`](config/postman-workspace-simulation.json).
Runtime retrieval fails closed if workspace membership or canonical content drifts.

## Reproduce the install-free proof

Requirements: Git and Node 20 or newer.

```bash
git clone --branch v0.6.4 --single-branch \
  https://github.com/postman-cs/paypal-pact-harness-cd.git
cd paypal-pact-harness-cd
test "$(git rev-parse HEAD)" = 6c2bd1c7c37bdfdcaf1fda12a8b9b7d92649ef97
node paypal-contract-gate.mjs doctor
node paypal-contract-gate.mjs verify --clean
```

Expected final line:

```text
[PASS] PayPal contract gate (lower)
```

Maintainers can reproduce the complete source-release gate from the default branch:

```bash
npm ci
npm run test:all
```

## Harness acceptance checklist

1. Import `harness/contract-gate.broker.pipeline.yaml` into the customer Harness
   project or use the generated customer-scoped copy.
2. Bind the read-only GitHub connector to this exact public repository.
3. Select tag `v0.6.4` and independently enter the reviewed 40-character commit.
4. Supply the registry connector, Kubernetes connector/namespace, both Postman
   workspace and Spec bindings, provider Collection binding, and logical Pact
   branches through the generated Input Set.
5. Create only the documented Harness secret references; never paste credentials
   into pipeline or Input Set YAML.
6. Use a stable customer-owned HTTPS Pact Broker. Temporary tunnel domains are
   accepted only for an explicitly temporary internal rehearsal and are rejected by
   the customer-package generator.
7. Confirm the `Consumer first Broker` stage passes every step and retains its
   JUnit, JSON, provenance, and checksum evidence.

Production adoption still requires executable Pact tests in each real consumer,
deterministic provider states, the exact provider build under test, a deployment
gate before promotion, Postman smoke tests after deployment, and
`record-deployment` only after those actions succeed.
