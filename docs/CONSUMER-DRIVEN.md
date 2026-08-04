# Consumer-driven direction

## Bottom line

The provider-focused spec↔application gate and consumer-driven contract testing
solve different problems and both should remain.

- Provider conformance asks whether the implementation and selected OAS surface
  agree, including rogue routes. In an OAS+codegen+Apigee estate this is still
  useful because handwritten controllers, gateway transforms, security policy,
  deployment skew, and undocumented routes can diverge from generated boilerplate.
- Consumer-driven testing asks whether a provider change still satisfies what
  each real consumer uses. It deliberately checks the consumer's minimal request
  and response assumptions, not every capability in the provider OAS.

The current phase-0 engine is **static Bi-Directional Contract checking**:
consumer Pact × provider OAS. A Postman collection with saved examples or a
consumer-owned OAS subset can become the consumer contract. This catches
consumer-breaking OAS changes without requiring a live provider.

On its own, that engine is not full Pact-style CDC. Generating a Pact from saved examples does not
prove that the consumer's real API client produced the request or handled the
response. The bounded verifier also implements only the OAS/Pact rules covered by
this repository; it is not a substitute for the official Pact matching engine.

## Implemented production evolution

1. Keep the Postman-CS spec↔application route stage for synchronization and
   mismatch/rogue detection.
2. Keep Postman as the API collaboration, examples, CLI execution, and JUnit
   surface. Postman can run collections in CI and keep collections/specifications
   synchronized, but that is not the same as Pact's consumer-code-generated
   contracts and provider verification matrix.
3. Important consumers now have a dedicated Harness publication stage for pacts
   produced by Pact JVM/JS/etc.
   tests that execute their real client code against a Pact mock.
4. A dedicated provider stage now invokes the official Pact verifier against a
   locally started provider, uses provider states, selectors, pending/WIP pacts,
   and publishes results for the exact provider SHA.
5. Dedicated OSS Broker stages now perform canonical `can-i-deploy` before the
   PayPal deployment and `record-deployment` only after it succeeds. The git ledger
   remains a low-infrastructure phase-0 choice, not an assertion of feature parity.
6. Keep static OAS BDC as a fast preflight for design/codegen changes even after
   dynamic provider verification is introduced.

The complete implementation and operating model are in
[`PACT-BROKER-RUNBOOK.md`](PACT-BROKER-RUNBOOK.md).

Official references:

- [How Pact works](https://docs.pact.io/getting_started/how_pact_works)
- [Pact provider verification](https://docs.pact.io/getting_started/provider_verification)
- [Pact Broker](https://docs.pact.io/pact_broker)
- [Postman CLI collection runs](https://learning.postman.com/docs/postman-cli/postman-cli-run-collection)
- [Postman specification/collection synchronization](https://learning.postman.com/docs/design-apis/collections/generate-specifications)
