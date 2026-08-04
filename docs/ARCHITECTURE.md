# Contract-gate architecture and execution flow

This repository owns the contract logic, its portable release, the Orders v2
proof application, and executable integrations for GitHub Actions, Harness,
Kubernetes, and Postman. Neither GitHub nor Harness contains a second copy of
the verdict logic: both invoke the same install-free bundle.

## System map

```mermaid
flowchart TB
  subgraph Authors["Contract and policy authors"]
    ConsumerPact["Consumer Pact v3"]
    ConsumerOAS["Consumer-owned OAS subset"]
    ConsumerCollection["Postman collection<br/>with saved examples"]
    ProviderOAS["Provider OAS<br/>PayPal Orders v2 demo"]
    Subset["Versioned subset selectors<br/>config/subsets/*.json"]
    Topology["Application/specification graph<br/>config/contract-topology.json"]
    Policy["Blocking policy<br/>config/contract-policy.json"]
    Exceptions["Governed exception register<br/>ticket, approver, scope, expiry"]
  end

  subgraph Build["Source, supply chain, and portable release"]
    EngineSource["Engine source<br/>src/"]
    UnitTests["92 deterministic tests<br/>test/"]
    LockedCS["Real postman-cs comparator<br/>full commit + SHA-256 lock"]
    SourceAttestation["Harness source attestation<br/>repo + commit + bundle provenance"]
    BundleBuild["Deterministic bundle builder"]
    Bundle["Install-free Node CLI bundle<br/>tools/pact-harness/"]
    Archive["Platform-agnostic .tgz<br/>Node 20+, no npm install"]

    EngineSource --> UnitTests
    LockedCS -->|"digest verified and vendored"| BundleBuild
    EngineSource --> BundleBuild --> Bundle --> Archive
    Bundle --> SourceAttestation
  end

  subgraph ContractEngine["Portable contract gate"]
    Normalize["Normalize consumer intent"]
    ToPact["OAS/Postman → Pact interactions<br/>type matchers, stable output"]
    BDC["Consumer compatibility<br/>Pact ↔ provider OAS"]
    Audit["OAS audit<br/>operation IDs, auth, success + negative responses,<br/>schema-valid examples"]
    Diff["Selected-surface schema diff<br/>breaking changes fail closed"]
    Select["Apply method/path/operation subset"]
    RouteGate["Bidirectional route parity<br/>missing-in-app + rogue-in-app"]
    ExceptionGate["Validate approved exceptions<br/>environment-scoped and unexpired"]
    Aggregate["Complete-results aggregator<br/>or fail-fast mode"]

    ConsumerPact --> Normalize
    ConsumerOAS --> ToPact
    ConsumerCollection --> ToPact
    ToPact --> Normalize --> BDC
    ProviderOAS --> BDC
    ProviderOAS --> Audit
    ProviderOAS --> Diff
    ProviderOAS --> Select
    Subset --> Select
    Policy --> RouteGate
    Exceptions --> ExceptionGate --> RouteGate
    BDC --> Aggregate
    Audit --> Aggregate
    Diff --> Aggregate
    RouteGate --> Aggregate
  end

  subgraph Runtime["Lower-environment runtime proof"]
    Spring["Authenticated Spring Boot Orders wrapper<br/>all 9 selected operations"]
    Actuator["Authoritative /actuator/mappings"]
    GeneratedOAS["Independent /v3/api-docs cross-check"]
    Inventory["Bounded inventory collector<br/>retry, timeout, redirect denial,<br/>JSON validation, SHA-256 manifest"]
    PostmanCLI["Postman CLI 1.45.0<br/>positive + negative cases"]
    CloudCollection["Stable Postman Cloud collection"]
    SealedSnapshot["Digest-sealed local snapshot<br/>workspace + SHA provenance"]

    Spring --> Actuator --> Inventory
    Spring --> GeneratedOAS --> Inventory
    CloudCollection --> SealedSnapshot --> PostmanCLI
    PostmanCLI -->|"bearer-authenticated loopback requests"| Spring
    Inventory --> Select --> RouteGate
  end

  subgraph Evidence["Verdict and evidence"]
    Verdict{"Promotion verdict"}
    JUnit["JUnit reports<br/>Harness test view"]
    JSON["Per-module + aggregate JSON"]
    Manifest["Evidence checksum manifest"]
    GitHubArtifacts["GitHub artifacts<br/>30-day retention"]
    Promotion["Harness promotion control"]

    Aggregate --> Verdict
    Aggregate --> JUnit
    Aggregate --> JSON --> Manifest
    JUnit --> GitHubArtifacts
    Manifest --> GitHubArtifacts
    Verdict -->|"green"| Promotion
    Verdict -->|"red"| Block["Block deployment"]
  end

  subgraph Platforms["Execution and ownership boundaries"]
    Local["Local CLI/demo"]
    Action["Reusable GitHub composite action"]
    GitHub["GitHub workflow<br/>test, package, prove failures, publish image"]
    HarnessStage["Modular Harness CI stage"]
    HarnessK8s["Harness KubernetesDirect pod"]
    K3s["Existing lower K3s cluster"]

    Bundle --> Local
    Bundle --> Action --> GitHub
    Bundle --> SourceAttestation --> HarnessStage --> HarnessK8s --> K3s
    GitHub --> GitHubArtifacts
    HarnessK8s --> Spring
    HarnessK8s --> PostmanCLI
    JUnit --> HarnessStage
    Verdict --> HarnessStage
  end

  subgraph OptionalLedger["Optional phase-0 deployment ledger"]
    PactVersions["Versioned pacts and provider releases"]
    Verifications["Verification results"]
    Deployments["Environment deployment records"]
    CanIDeploy["can-i-deploy"]

    PactVersions --> Verifications --> CanIDeploy
    Deployments --> CanIDeploy
    CanIDeploy --> Verdict
  end

  Topology -->|"one-to-many and many-to-many edges"| HarnessStage
  Topology --> Select
  Archive --> Action
  Archive --> HarnessStage
```

## End-to-end execution

```mermaid
sequenceDiagram
  autonumber
  actor Consumer as Consumer/API team
  participant Git as GitHub
  participant Bundle as Portable contract bundle
  participant Harness as Harness CI
  participant Pod as KubernetesDirect pod
  participant App as Spring Orders wrapper
  participant Postman as Postman Cloud/CLI
  participant Evidence as JUnit + JSON evidence

  Consumer->>Git: Commit Pact, consumer OAS, or Postman examples
  Git->>Bundle: Test, rebuild, verify postman-cs digest, package
  Bundle->>Bundle: Audit OAS and verify consumer schemas/examples
  Git->>Git: Prove schema drift and rogue routes fail closed
  Git->>Git: Publish commit-SHA-tagged wrapper image, SBOM, provenance, and retained evidence

  Harness->>Pod: Schedule modular lower-environment CI stage
  Pod->>App: Build and start authenticated Spring Background step
  Pod->>App: Poll Actuator mappings and generated OpenAPI
  App-->>Pod: Authoritative and secondary route inventories
  Pod->>Bundle: Run complete contract gate with subset and policy
  Bundle->>Bundle: Consumer BDC + OAS audit + route parity
  Bundle-->>Evidence: 24 contract JUnit cases + JSON/checksums
  Pod->>Postman: Run stable collection with Postman CLI 1.45.0
  Postman->>App: Exercise 9 operations and auth-negative cases
  App-->>Postman: Schema-conformant responses
  Postman-->>Evidence: 12 JUnit cases + JSON + collection provenance
  Evidence-->>Harness: Render test results
  Harness->>Pod: Clean up ephemeral build pod

  alt Every blocking check passes
    Harness-->>Consumer: Allow downstream promotion
  else Any contract, route, policy, security, or runtime check fails
    Harness-->>Consumer: Block promotion with complete mismatch evidence
  end
```

## Responsibility split

| Component | Responsibility |
| --- | --- |
| Repository bundle | Contract semantics and deterministic verdicts |
| Consumer teams | Executable consumer intent: Pact, OAS subset, or Postman examples |
| Provider/application teams | Candidate OAS and runtime implementation |
| Postman | API collaboration artifacts and CLI execution of a workspace- and digest-verified Collection snapshot |
| GitHub | Source validation, portable packaging, failure proofs, evidence retention, and image publication |
| Harness | Kubernetes execution, JUnit presentation, and deployment/promotion control |
| Kubernetes | Ephemeral lower-environment runtime isolation |
| Optional git ledger | Low-infrastructure version/deployment compatibility history |
