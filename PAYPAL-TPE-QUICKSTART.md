# PayPal TPE quick start

This is the shortest supported path. It needs Git and Node 20 or newer. It does
not need `npm install`, Docker, a Pact Broker, or a dedicated host.

## 1. Clone and prove the supplied lower profile

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
existing promotion stage in the PayPal application pipeline. The application
repository remains the primary checkout. A native additional `GitClone` pulls only
`postman-cs/paypal-pact-harness-cd` using a read-only connector whose URL is exactly
`https://github.com/postman-cs/paypal-pact-harness-cd.git`.

Bind these input groups:

- the Postman-CS Git connector, approved release tag, and exact reviewed commit;
- the container-registry connector, Kubernetes connector, and namespace;
- the application base, Actuator, and generated OpenAPI URLs;
- the customer profile path; and
- either a customer-repository Collection path or the Postman Cloud Collection
  UID, workspace ID, reviewed canonical digest, and explicit cloud-mode switch.

The supplied consumer publication stage executes JavaScript consumers in its
digest-pinned Node image. A Java or .NET consumer team should copy that stage and
replace only the generation step's image with an approved digest-pinned language
runtime; the publication and attestation steps stay unchanged.

Harness reads credentials only from the documented project secrets. Use the
protected `v0.6.4` toolkit tag and its reviewed full commit, or a later protected
release; never bind a customer pipeline to a floating development branch.

The contract, subset, policy, exceptions, and report location stay in the single
versioned JSON profile. Harness injects credentials from secrets and runs the
same `verify` command in Kubernetes. Its first step verifies the full checkout
identity and Harness commit SHA, then validates the portable CLI and locked
Postman-CS comparator before any customer endpoint is called.

If the PayPal runtime cannot read the Postman-CS repository, follow
[`docs/DOWNSTREAM-ADOPTION.md`](docs/DOWNSTREAM-ADOPTION.md) and use the explicitly
offline `consumer-contract-gate.vendored.yaml` stage instead.

## 4. Import the single-repository Broker proof

For the supplied Orders integration demonstration, import
`harness/contract-gate.broker.pipeline.yaml` from this repository. Its primary
codebase is `paypal-pact-harness-cd`; no second code repository is needed. The
template uses neutral runtime inputs for the container registry, Kubernetes
connector, and namespace.

The committed Postman binding already supplies the simulation workspace, Spec,
Collection, and reviewed digest values. Generate the remaining Harness bindings
from one customer-owned file:

```bash
mkdir -p .contract-handoff
cp config/paypal-tpe-handoff.example.json .contract-handoff/config.json
# Replace every Harness, connector, namespace, Broker, and Postman placeholder.
npm run handoff:doctor
npm run handoff:prepare
npm run customer:package
```

The generator proves the selected release tag still resolves to its reviewed full
commit and covers all 18 pipeline variables. `handoff:prepare` writes the minimal
Input Set and checklist. `customer:package` additionally writes a versioned `.tgz`
containing the import-ready demo, production stages, install-free local proof,
full-file integrity manifest, verifier, notices, and SBOM. In Harness, import the
pipeline and Input Set under the kit's `demo/` directory, confirm the three project
secret identifiers, then execute the Input Set.

The package contains no credential values, but connector names, Broker coordinates,
namespaces, and Postman identities are customer-confidential operational metadata.
Distribute it only through the approved customer channel.

This proof uses the demo provider and seeded consumer Pact. It is not a substitute
for consumer-generated contracts, a PayPal deployment, target-environment smoke
tests, or `record-deployment`.

## Optional local Postman runtime cases

The Harness stage requires an explicitly selected customer Collection and runs its
sealed snapshot with Postman CLI 1.45.0. For an optional local run, set
`postman.enabled` to `true`, set `postman.baseUrl`, and supply:

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
