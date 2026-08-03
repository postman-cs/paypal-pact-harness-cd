# PayPal TPE quick start

This is the shortest supported path. It needs Git and Node 20 or newer. It does
not need `npm install`, Docker, a Pact Broker, or a dedicated host.

## 1. Clone and prove the supplied lower profile

```bash
git clone https://github.com/postman-cs/paypal-pact-harness-cd.git
cd paypal-pact-harness-cd
node paypal-contract-gate.mjs doctor
node paypal-contract-gate.mjs verify --clean
```

Expected final line:

```text
[PASS] PayPal contract gate (lower)
```

Evidence is written under `.contract-reports/` as JUnit, JSON, and a SHA-256
manifest.

## 2. Point the profile at one PayPal service

Edit only `paypal-contract-gate.config.json`:

1. `provider.oas` — the provider OpenAPI file.
2. `consumer.contract` and `consumer.format` — Pact, consumer OAS, or a Postman
   collection with saved examples.
3. `application.routes` — a checked-in route inventory for an offline proof.
4. `policy.subset` — the operations this application owns.

Then rerun the same two commands.

For a live lower Spring service, leave secrets out of the file and override the
runtime endpoints:

```bash
export PAYPAL_CONTRACT_ACTUATOR_URL="https://lower.example/actuator/mappings"
export PAYPAL_CONTRACT_OPENAPI_URL="https://lower.example/v3/api-docs"
export INVENTORY_BEARER_TOKEN="..."
# Optional when the application starts in parallel with the gate (1-120):
export PAYPAL_CONTRACT_INVENTORY_ATTEMPTS="60"
node paypal-contract-gate.mjs verify --clean
```

The Actuator and generated-OpenAPI URLs must be supplied together. Actuator is
the authoritative route inventory; generated OpenAPI is cross-checked
independently.

## 3. Add the existing Harness stage

Import `harness/stages/consumer-contract-gate.yaml` immediately before the
existing promotion stage. Use a repository-scoped GitHub connector whose URL is
exactly `https://github.com/postman-cs/paypal-pact-harness-cd.git`. The import has
five meaningful inputs:

- codebase connector;
- Kubernetes connector and namespace;
- application base URL;
- Actuator URL; and
- generated OpenAPI URL.

The contract, subset, policy, exceptions, and report location stay in the single
versioned JSON profile. Harness injects credentials from secrets and runs the
same `verify` command in Kubernetes. Its first step verifies the full checkout
identity and Harness commit SHA, then validates the portable CLI and locked
Postman-CS comparator before any customer endpoint is called.

## Optional Postman runtime cases

The Harness stage runs the committed collection with Postman CLI 1.45.0. For a
local run, set `postman.enabled` to `true`, set `postman.baseUrl`, and supply:

```bash
export CONTRACT_DEMO_TOKEN="..."
# Only when postman.cloud=true:
export POSTMAN_API_KEY="..."
node paypal-contract-gate.mjs doctor
node paypal-contract-gate.mjs verify --clean
```

Tokens, passwords, and API keys belong only in the runner environment or Harness
Secrets. The JSON profile contains no credential fields.

## Failure behavior

The default profile is blocking and complete-results:

- consumer-breaking schema drift fails;
- missing implementation routes fail;
- rogue application routes fail;
- invalid security, negative cases, or examples fail;
- malformed or expired exceptions fail; and
- all modules finish so the team receives one complete evidence set.

`policy.route=warn` and fail-fast mode remain available for deliberate advanced
use, but are not the PayPal TPE default.
