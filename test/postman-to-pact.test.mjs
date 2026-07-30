import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDoc } from '../src/lib/load.mjs';
import { serialize, PACT_SPEC_VERSION } from '../src/lib/pact.mjs';
import { postmanToPact } from '../src/postman-to-pact.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const collection = loadDoc(join(FIX, 'checkout-app-collection.json'));

test('requires a provider name', () => {
  assert.throws(() => postmanToPact(collection, {}), /provider name is required/);
});

test('names consumer from the collection and provider from the option', () => {
  const pact = postmanToPact(collection, { provider: 'paypal-orders' });
  assert.equal(pact.consumer.name, 'checkout-app');
  assert.equal(pact.provider.name, 'paypal-orders');
  assert.equal(pact.metadata.pactSpecification.version, PACT_SPEC_VERSION);
});

test('turns each saved example response into an interaction', () => {
  const pact = postmanToPact(collection, { provider: 'paypal-orders' });
  assert.equal(pact.interactions.length, 1);
  const i = pact.interactions[0];
  assert.equal(i.request.method, 'GET');
  assert.equal(i.request.path, '/orders/123');
  assert.equal(i.response.status, 200);
  assert.equal(i.response.body.status, 'COMPLETED');
});

test('drops volatile headers (auth, request-id) but keeps contract headers', () => {
  const pact = postmanToPact(collection, { provider: 'paypal-orders' });
  const i = pact.interactions[0];
  assert.equal(i.request.headers.Authorization, undefined);
  assert.equal(i.request.headers.Accept, 'application/json');
  assert.equal(i.response.headers['X-Request-Id'], undefined);
  assert.equal(i.response.headers['Content-Type'], 'application/json');
});

test('emits TYPE matchers (not exact values) for every response leaf', () => {
  const pact = postmanToPact(collection, { provider: 'paypal-orders' });
  const rules = pact.interactions[0].response.matchingRules.body;
  for (const p of ['$.id', '$.status', '$.total.amount', '$.items[*].sku', '$.items[*].quantity']) {
    assert.ok(rules[p], `expected a matcher at ${p}`);
    assert.equal(rules[p].matchers[0].match, 'type');
  }
  // arrays get a type matcher at the array node too
  assert.equal(rules['$.items'].matchers[0].match, 'type');
});

test('is deterministic — two runs are byte-identical', () => {
  const a = serialize(postmanToPact(collection, { provider: 'paypal-orders' }));
  const b = serialize(postmanToPact(collection, { provider: 'paypal-orders' }));
  assert.equal(a, b);
});

test('matches the committed golden pact', () => {
  const golden = loadDoc(join(FIX, 'checkout-app.pact.json'));
  const rendered = JSON.parse(serialize(postmanToPact(collection, { provider: 'paypal-orders' })));
  assert.deepEqual(rendered, golden);
});
