# Third-party components & licences

This project is **OSS-only and PactFlow-independent** (Decision D3). Capture every
adopted component's licence here **before** it is pinned/deployed.

## Runtime dependency (in `package.json`)

| Package | Version | Licence | Use |
| --- | --- | --- | --- |
| `yaml` | ^2.5.1 | MIT (verify at pin) | parse OAS / collection YAML (Decision D4) |

Everything else in `src/` is Node stdlib. No network, no telemetry, no EchoAtlas packages.

## Infrastructure components — none

The dynamic-replay leg (`pact_verifier_cli`, the mock plane) was dropped 2026-07-29,
and the **OSS Pact Broker + Postgres were dropped too** — the cross-team `can-i-deploy`
system of record is now a **git-backed contract ledger** (Decision D12), which needs no
runtime component: the store is a git repo, the verdict is a pure computation in CI.

So there is **nothing to adopt, pin, or licence beyond `yaml` above** — no broker image,
no database, no server. The only runtime dependency remains `yaml` (MIT).

## D3 diligence — RESOLVED (2026-07-29)

**Finding:** Bi-Directional Contracts (the OAS-as-provider-contract cross-verify via
`can-i-deploy`) is **PactFlow-commercial**. Per PactFlow's own docs, *"the open source
Pact Broker does not support the bi-directional testing approach"* — BDC
cross-contract verification is a PactFlow feature. The OSS Pact Broker fully supports
the **consumer-driven** flow (publish pacts, provider verification results,
`can-i-deploy` across consumer/provider versions) and self-hosting.

**Consequence (validates the D3 design):** we **own the BDC cross-check**
(`src/bdc-verify.mjs`) — consumer pact × provider OAS, statically — so PayPal gets the
bi-directional capability **without a PactFlow license**, and we stay OSS-only +
self-hostable. The OSS Broker is used for what it's good at: storage, versioning, and
`can-i-deploy` aggregation of the verification results we publish. This is a selling
point, not a gap: the one paid feature is the one we replaced.

Sources: [PactFlow OSS vs self-hosted](https://pactflow.io/oss/) ·
[Bi-directional contracts](https://pactflow.io/blog/bi-directional-contracts/) ·
[OSS vs PactFlow differences](https://github.com/cloudbackenddev/pact-docs).
