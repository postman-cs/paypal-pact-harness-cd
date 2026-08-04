# Single-repository PayPal handoff

PayPal can receive one code repository:

```text
https://github.com/postman-cs/paypal-pact-harness-cd.git
```

For the complete integration demonstration, import
`harness/contract-gate.broker.pipeline.yaml` from that repository and select the
reviewed branch, tag, or commit as the Harness codebase build. The pipeline does
not require a consumer repository, provider repository, or utility repository to
run its supplied Orders demonstration.

## Runtime bindings

One repository does not mean zero external runtime configuration. Create a Harness
Input Set that binds customer-owned resources without committing their names:

| Input | Customer binding |
| --- | --- |
| CI codebase connector | Read-only GitHub connector scoped to this repository |
| `CONTAINER_REGISTRY_CONNECTOR` | Registry connector permitted to pull the digest-pinned Node and Maven images |
| `KUBERNETES_CONNECTOR` | Delegate-backed connector for the selected customer Kubernetes cluster |
| `KUBERNETES_NAMESPACE` | Disposable lower-environment namespace |
| `BROKER_BASE_URL` | Customer-operated OSS Pact Broker |
| `REVIEWED_SOURCE_COMMIT` | Full reviewed SHA matching the selected checkout |
| `CONSUMER_PACT_BRANCH`, `PROVIDER_PACT_BRANCH` | Explicit logical Pact branches |
| Consumer/provider workspace and Spec IDs | The two approved Postman workspaces and OAS documents |
| Consumer/provider canonical OAS digests | Reviewed digests for those exact OAS documents |
| Provider Collection UID, workspace ID, and digest | Approved behavioral Collection snapshot |
| `INCLUDE_WIP_PACTS_SINCE` | Reviewed WIP introduction date |
| `TARGET_ENVIRONMENT` | Broker environment queried by `can-i-deploy` |

Create Harness secret references for the Postman service-account API key, Pact
Broker password, and demo provider token. No credential belongs in the pipeline
YAML or Input Set.

## What the imported proof demonstrates

The complete pipeline attests the exact GitHub checkout, pulls both OAS documents
from their declared Postman workspaces, runs static compatibility and provider
conformance, executes the approved provider Collection, publishes the supplied
seeded consumer Pact, verifies the demo provider through the Broker, and queries
`can-i-deploy`.

This is an integration proof for the supplied Orders demonstration. It must not be
described as a PayPal production deployment or as proof that a real consumer client
created and handled the interactions.

## What “fully built out” still requires

The production consumer-driven lifecycle needs customer-owned work outside this
single demonstration pipeline:

1. Bind every additional-clone modular stage to commit-pinned release `v0.6.5`
   and its independently reviewed full commit, or to a later commit-pinned release.
2. Add `pact-consumer-publish.yaml` to each real consumer repository and run its
   Pact tests against the production client code. Do not publish the seeded fixture.
3. Start the exact provider build and implement deterministic, CI-only provider
   states before `pact-provider-verify.yaml`.
4. Require an actual provider verification result and a non-empty Broker dependency
   decision; a pending-only verification or empty matrix is not compatibility proof.
5. Place `pact-can-i-deploy.yaml` immediately before the real deployment, run the
   target-environment Postman smoke Collection, and invoke
   `pact-record-deployment.yaml` only after both succeed.
6. Operate and back up the Pact Broker, rotate credentials, and upload JSON,
   provenance, and checksum evidence to the customer retention system.

Those boundaries are intentional: the repository supplies portable testing logic
and Harness templates, while PayPal continues to own applications, deployment,
runtime infrastructure, credentials, and production evidence retention.
