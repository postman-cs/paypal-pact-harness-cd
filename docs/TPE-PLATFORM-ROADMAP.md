# Postman TPE contract-testing product path

The repository is the reference implementation; the platform product should make
the safe path repeatable across many teams without copying demo assumptions.

## Available now

- One repository supplies the install-free engine, complete Harness pipeline, and
  modular stages.
- One credential-free JSON file generates all 18 runtime inputs, a Harness Input
  Set, a release attestation, an operator checklist, and a versioned customer kit.
- `postman:seed-demo` is the explicitly mutating simulation provisioner;
  `postman:inspect` is the read-only drift and compatibility check.
- Postman CLI evidence is accepted only when requests and assertions are non-empty,
  successful, and unskipped in both JSON and JUnit reporters.
- Customer URLs, connectors, and Kubernetes namespaces are required inputs in the
  reusable stage; no PayPal demo topology is silently selected.

## Next platform increment

1. Publish the modular stages in the Harness Template Library with semantic
   versions, a centrally owned connector policy, and organization-level Input Set
   overlays for standard registry and cluster bindings.
2. Add a Postman asset lock command that captures workspace membership, IDs,
   canonical OAS and Collection digests, release provenance, and owner metadata in
   a reviewed lock file. Separate `plan` from `apply`; only `apply` may mutate cloud
   assets.
3. Extend specification pulling from one `ROOT` file to governed multi-file OAS
   bundles with a deterministic dependency graph and digest over every referenced
   file.
4. Add a credential-rotation runbook and a non-secret health check for the Postman
   service account, Pact Broker, registry, GitHub, Kubernetes, and corporate CA or
   egress path before a pipeline consumes build minutes.
5. Upload the evidence manifest, JUnit, Postman provenance, Broker verification
   URL, and `can-i-deploy` matrix to a central TPE evidence store. Build scorecards
   for adoption, drift, flaky assertions, pending/WIP age, and blocked promotions.

## Production boundary

The seeded Orders Pact is integration evidence, not a consumer-owned production
contract. Each real consumer must generate and publish its Pact from executable
client tests. Each provider must run deterministic provider states against the
candidate build. Promotion remains blocked until Broker verification and a
non-empty `can-i-deploy` decision pass; deployment is recorded only after the real
deployment and target-environment Postman smoke tests succeed.
