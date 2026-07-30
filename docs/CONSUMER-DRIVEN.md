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

It is not yet full Pact-style CDC. Generating a Pact from saved examples does not
prove that the consumer's real API client produced the request or handled the
response. The bounded verifier also implements only the OAS/Pact rules covered by
this repository; it is not a substitute for the official Pact matching engine.

## Recommended production evolution

1. Keep the Postman-CS spec↔application route stage for synchronization and
   mismatch/rogue detection.
2. Keep Postman as the API collaboration, examples, CLI execution, and JUnit
   surface. Postman can run collections in CI and keep collections/specifications
   synchronized, but that is not the same as Pact's consumer-code-generated
   contracts and provider verification matrix.
3. Move important consumers from saved-example conversion to Pact JVM/JS/etc.
   tests that execute their real client code against a Pact mock.
4. Verify those pacts with the official Pact verifier against a locally started
   provider in CI (the Spring wrapper demonstrates the shape). Use provider states
   for deterministic data.
5. Use an OSS Pact Broker or PactFlow when PayPal wants mature version selectors,
   pending/WIP pacts, webhooks, and canonical `can-i-deploy`. The git ledger is a
   low-infrastructure phase-0 choice, not an assertion of feature parity.
6. Keep static OAS BDC as a fast preflight for design/codegen changes even after
   dynamic provider verification is introduced.

Official references:

- [How Pact works](https://docs.pact.io/getting_started/how_pact_works)
- [Pact provider verification](https://docs.pact.io/getting_started/provider_verification)
- [Pact Broker](https://docs.pact.io/pact_broker)
- [Postman CLI collection runs](https://learning.postman.com/docs/postman-cli/postman-cli-run-collection)
- [Postman specification/collection synchronization](https://learning.postman.com/docs/design-apis/collections/generate-specifications)
