# Postman consumer/provider workspace simulation

This phase-0 proof uses two team workspaces and keeps ownership explicit:

| Role | Workspace | OAS | Collection |
|---|---|---|---|
| Consumer | `PayPal Pact Simulation - Consumer` | the narrow surface the checkout consumer relies on | consumer-owned saved request/response examples |
| Provider | `PayPal Pact Simulation - Provider` | the fuller PayPal Orders provider contract | provider runtime and authentication checks |

The setup command creates or reuses exact-name workspaces, specifications, and
collections. It updates assets in place, rejects duplicate exact names, never
deletes cloud resources, and writes only non-secret IDs and source digests.

```sh
export POSTMAN_API_KEY='use-a-team-or-service-account-key'
npm run postman:setup
npm run postman:verify
```

The default is a team workspace. For an individual API key that isn't operating
in a team context, use `npm run postman:setup -- --workspace-type personal`.
PayPal should keep the default and provision with its team/service-account key.

`postman:verify` pulls the exact single `ROOT` file for both live OAS documents
and both live Collections, proves that every asset belongs to its declared
workspace, and records byte and canonical SHA-256 provenance. It rejects
multi-file or ambiguous-root specifications and fails if either OAS canonical
digest or either Collection canonical digest differs from the reviewed binding
config. Collection drift is rejected before prior reports or input snapshots are
changed. It then runs two passing
compatibility paths against the live provider OAS:

1. consumer OAS -> Pact-shaped contract -> static BDC verification
2. consumer Collection examples -> Pact-shaped contract -> static BDC verification

Evidence is written under `.contract-reports/postman-workspace-simulation/`.
The generated `config/postman-workspace-simulation.json` contains IDs, names,
fixture paths, and digests; it never contains the Postman API key.

For Harness, map the generated IDs to `CONSUMER_WORKSPACE_ID`,
`CONSUMER_SPEC_ID`, `PROVIDER_WORKSPACE_ID`, and `PROVIDER_SPEC_ID`. Use the
generated `sourceCanonicalSha256` values as the approved OAS digests. Use the
consumer Collection's `canonicalSha256` as
`CONSUMER_COLLECTION_CANONICAL_SHA256` in the real-consumer pipeline. Use the
provider Collection UID, provider workspace ID, and its `canonicalSha256` for
the lower-environment Postman CLI step. Each runner proves
workspace membership and content, then executes a mode-`0600` sealed snapshot.
After Postman CLI returns, JSON, JUnit, and retained text output are redacted and
re-sealed; malformed reporter output or any credential that survives redaction
fails the run and is removed.
Store the key only in `paypal_postman_service_account_pmak`.

This is deliberately labeled **phase 0**. It proves Postman-backed static
bi-directional compatibility and prepares provider conformance execution. A
true phase-1 Pact CDC proof additionally requires an executable consumer test
using the official Pact mock, a live Pact Broker, deterministic provider
states, published verification results, `can-i-deploy`, a real deployment,
Postman smoke tests, and `record-deployment` after those tests pass.

Maintainers can run the same cloud-backed proof and the provider Collection
against the CI-hosted Spring candidate with the `Contract gate` workflow's
`postman_cloud` dispatch input. The workflow requires the temporary or governed
repository secret `POSTMAN_SIMULATION_PMAK`; ordinary push and pull-request runs
remain fixture-backed and do not require a cloud credential.
