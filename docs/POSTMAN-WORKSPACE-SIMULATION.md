# Postman consumer/provider workspace simulation

This phase-0 proof uses two team workspaces and keeps ownership explicit:

| Role | Workspace | OAS | Collection |
|---|---|---|---|
| Consumer | `PayPal Pact Simulation - Consumer` | the narrow surface the checkout consumer relies on | consumer-owned saved request/response examples |
| Provider | `PayPal Pact Simulation - Provider` | the fuller PayPal Orders provider contract | provider runtime and authentication checks |

The demo seeder creates or reuses exact-name workspaces, specifications, and
collections. It updates assets in place, rejects duplicate exact names, never
deletes cloud resources, and writes only non-secret IDs and source digests. Use it
only when deliberately provisioning or resetting the supplied simulation assets.
The inspector is read-only: it pulls, attests, and tests the bound cloud assets
without modifying Postman.

```sh
export POSTMAN_API_KEY='use-a-team-or-service-account-key'
npm run postman:seed-demo -- --apply \
  --owner-id '<authenticated-postman-owner-id>' \
  --owner postman-cs --classification public-demo \
  --approved-for-public-evidence --approval-expires 2027-08-04 \
  --team-id '<approved-team-id>' --maintenance-mode
npm run postman:inspect   # read-only verification
```

The seeder refuses to mutate without `--apply`, verifies `/me` against the exact
expected owner ID before any POST/PATCH, requires an explicit public-demo approval
window, and requires `--maintenance-mode` to rewrite the tracked binding. The
default is a team workspace and requires its approved team ID. For an individual
API key, add `--workspace-type personal` and omit `--team-id`.
PayPal should keep the default and provision with its team/service-account key.
The legacy `postman:setup` and `postman:verify` aliases remain available. All four
commands execute the committed install-free bundle, so a customer clone does not
need `npm install`.

`postman:inspect` pulls the exact single `ROOT` file for both live OAS documents
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
The generated `config/postman-workspace-simulation.json` is an explicitly
Postman-CS-hosted demonstration binding. It contains IDs, names, fixture paths,
and digests; it never contains the Postman API key.

Do not use those identities as a customer default. Customer handoffs start from
`config/paypal-tpe-handoff.example.json`, whose inline Postman binding requires
customer-owned workspace, Spec, Collection, and canonical-digest values.
Create that binding without changing Postman by running
`npm run postman:lock-assets -- --help`; the command uses only GET requests,
verifies each workspace relationship, and writes under ignored
`.contract-handoff/` only when `--out` is supplied.

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
