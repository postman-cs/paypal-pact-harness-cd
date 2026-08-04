import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDoc } from '../src/lib/load.mjs';
import { oasToPact } from '../src/oas-to-pact.mjs';
import { providerVerify, providerContract } from '../src/provider-verify.mjs';
import { bdcVerify, canIDeploy } from '../src/bdc-verify.mjs';
import { postmanToPact } from '../src/postman-to-pact.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'paypal');
const providerOas = loadDoc(join(FIX, 'checkout_orders_v2.json'));
const driftOas = loadDoc(join(FIX, 'checkout_orders_v2.drift.json'));
const consumerOas = loadDoc(join(FIX, 'checkout-consumer-oas.json'));

// ── consumer FROM OAS ──
test('oasToPact turns a consumer OAS into a pact of the fields it declares', () => {
  const pact = oasToPact(consumerOas, { provider: 'paypal-orders', consumer: 'checkout-consumer' });
  assert.equal(pact.consumer.name, 'checkout-consumer');
  assert.equal(pact.interactions.length, 2);
  const body = pact.interactions[0].response.body;
  assert.deepEqual(Object.keys(body).sort(), ['id', 'intent', 'purchase_units', 'status']);
  assert.equal(pact.interactions[0].response.status, 200);
  assert.equal(pact.interactions[1].response.status, 404);
  assert.match(pact.interactions[1].description, /404/);
});

test('OAS-vs-OAS: consumer OAS verifies against the provider OAS, breaks on drift', () => {
  const pact = oasToPact(consumerOas, { provider: 'paypal-orders' });
  assert.equal(canIDeploy(bdcVerify(providerOas, pact)).deployable, true);
  const drift = canIDeploy(bdcVerify(driftOas, pact));
  assert.equal(drift.deployable, false);
  assert.ok(drift.reasons.some((r) => r.includes('$.status')));
});

// ── provider SUPPLIES its end ──
test('providerContract summarizes the provider OAS', () => {
  const c = providerContract(providerOas, { name: 'paypal-orders' });
  assert.equal(c.provider, 'paypal-orders');
  assert.ok(c.operations >= 1);
  assert.match(c.contentHash, /^[0-9a-f]{8}$/);
});

test('providerVerify: a good OAS satisfies all consumers; a drifted one is blocked', () => {
  const p1 = postmanToPact(loadDoc(join(FIX, 'orders-checkout-consumer.postman_collection.json')), { provider: 'paypal-orders' });
  const p2 = postmanToPact(loadDoc(join(FIX, 'orders-lite-consumer.postman_collection.json')), { provider: 'paypal-orders' });
  const consumers = [{ consumer: p1.consumer.name, pact: p1 }, { consumer: p2.consumer.name, pact: p2 }];
  const good = providerVerify(providerOas, consumers, { name: 'paypal-orders' });
  assert.equal(good.deployable, true);
  assert.equal(good.summary.consumers, 2);

  const drift = providerVerify(driftOas, consumers, { name: 'paypal-orders' });
  assert.equal(drift.deployable, false);
  // exactly the checkout consumer breaks; the reporting one is fine
  const byName = Object.fromEntries(drift.perConsumer.map((c) => [c.consumer, c.deployable]));
  assert.equal(byName['orders-checkout-consumer'], false);
  assert.equal(byName['orders-reporting-consumer'], true);
});

test('providerVerify is deterministic', () => {
  const consumers = [{ consumer: 'c', pact: oasToPact(consumerOas, { provider: 'paypal-orders' }) }];
  assert.deepEqual(providerVerify(providerOas, consumers), providerVerify(providerOas, consumers));
});
