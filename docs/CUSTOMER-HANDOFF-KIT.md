# Customer handoff kit

`npm run customer:package` turns the reviewed repository and one credential-free
customer configuration into a focused delivery artifact. The customer does not
need the engineering tests, drift fixtures, legacy pipeline shapes, GitHub workflow,
or Postman cloud-provisioning tools to evaluate or adopt the capability.

## Build

```bash
mkdir -p .contract-handoff
cp config/paypal-tpe-handoff.example.json .contract-handoff/config.json
# Replace every REPLACE placeholder, including the versioned release tag and independently reviewed commit.
npm run handoff:doctor
npm run customer:package
```

The packaging command rejects a dirty tracked worktree, a moved release tag,
incomplete Postman assets, non-HTTPS Broker URL, missing Harness variables, and
pre-existing output unless replacement is explicitly requested. Customer bindings
and artifacts stay under ignored `.contract-handoff/` paths.

## Generated artifact

```text
paypal-pact-harness-customer-confidential-kit-vX.Y.Z/
├── START-HERE.md
├── KIT-MANIFEST.json
├── SHA256SUMS
├── first-run.mjs
├── verify-kit.mjs
├── run-demo.mjs
├── DISTRIBUTION-NOTICE.md
├── THIRD-PARTY-NOTICES.md
├── demo/
│   ├── harness-pipeline.yaml
│   ├── harness-input-set.yaml
│   ├── postman-bindings.json
│   ├── required-secrets.md
│   ├── network-prerequisites.md
│   └── expected-first-run.md
├── production/
│   ├── README.md
│   └── stages/
├── demo-local/
├── toolkit/
└── provenance/
    ├── release.json
    ├── sbom.cdx.json
    └── dependency lock files
```

The adjacent `.tgz.sha256` covers the archive, and the adjacent `.tgz.DELIVERY.md`
contains exact macOS, Linux, and PowerShell verification and extraction commands.
Inside, `KIT-MANIFEST.json` covers every shipped file except itself, and
`verify-kit.mjs` rejects changed, missing,
extra, or symbolic-link entries. It also validates the release attestation, all 18
Harness inputs, Postman identities and canonical digests, and absence of
credential-shaped values, cloud-mutating Postman administration scripts, and the
Git-backed ledger writer.

## Customer flow

After extraction, run one command:

```bash
node first-run.mjs
```

Then import `demo/harness-pipeline.yaml` and `demo/harness-input-set.yaml`, create
the three secret identifiers named in `demo/required-secrets.md`, and execute the
Input Set. The passing demo and the modular production adoption templates are kept
in separate directories to prevent seeded integration evidence from being mistaken
for a real consumer-owned production contract.

## Distribution boundary

The kit contains no credential values, but it does contain customer connector
names, cluster namespace, Pact Broker coordinate, and Postman workspace and asset
identities. Treat it as customer-confidential operational metadata. Postman-authored
code remains governed by the applicable customer agreement; engineering must not
invent or attach a standalone license grant. Third-party notices and the SBOM are
included for review.

Configured kits are confidential delivery artifacts, not GitHub Release or CI
artifacts. Never upload a configured kit, its checksum, or its DELIVERY guide to a
public GitHub Release, a public-repository workflow artifact, or public object
storage. Deliver all three files together only through PayPal's approved
access-controlled channel. Public releases may contain only the generic,
customer-unbound toolkit.

The checksum detects corruption. Authenticity depends on the approved delivery
channel. Where policy requires signed provenance, verify the accompanying
signature or attestation before extraction.
