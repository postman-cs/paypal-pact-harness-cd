import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDoc } from '../src/lib/load.mjs';
import { bdcVerify, canIDeploy, verifyInteraction } from '../src/bdc-verify.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const goodOas = loadDoc(join(FIX, 'orders-oas.yaml'));
const breakingOas = loadDoc(join(FIX, 'orders-oas-breaking.yaml'));
const pact = loadDoc(join(FIX, 'checkout-app.pact.json'));

test('a consumer pact verifies against the matching OAS -> deployable', () => {
  const result = bdcVerify(goodOas, pact);
  assert.equal(result.ok, true);
  assert.equal(result.summary.passed, 1);
  assert.equal(canIDeploy(result).deployable, true);
});

test('a renamed response field (status->state) breaks the consumer -> NOT deployable', () => {
  const result = bdcVerify(breakingOas, pact);
  assert.equal(result.ok, false);
  const verdict = canIDeploy(result);
  assert.equal(verdict.deployable, false);
  assert.ok(verdict.reasons.some((r) => r.includes('response-field-missing') && r.includes('$.status')),
    `expected a $.status missing reason, got: ${verdict.reasons.join(' | ')}`);
});

test('calling an endpoint the provider does not offer fails operation-exists', () => {
  const orphan = {
    description: 'ghost',
    request: { method: 'GET', path: '/nope/1' },
    response: { status: 200 },
  };
  const r = verifyInteraction(goodOas, orphan);
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].check, 'operation-exists');
});

test('expecting an undocumented status fails response-status', () => {
  const i = {
    description: 'teapot',
    request: { method: 'GET', path: '/orders/1' },
    response: { status: 418 },
  };
  const r = verifyInteraction(goodOas, i);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.check === 'response-status'));
});

test('a field the consumer reads with the wrong type fails response-field-type', () => {
  const i = {
    description: 'wrong-type',
    request: { method: 'GET', path: '/orders/1' },
    // consumer treats id as a STRING; OAS declares integer
    response: { status: 200, body: { id: 'not-a-number' } },
  };
  const r = verifyInteraction(goodOas, i);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.check === 'response-field-type' && f.detail.includes('$.id')));
});

test('a missing required provider query param is flagged', () => {
  // Make `fields` required in a local OAS clone.
  const oas = JSON.parse(JSON.stringify(goodOas));
  oas.paths['/orders/{orderId}'].get.parameters[1].required = true;
  const i = {
    description: 'no-fields',
    request: { method: 'GET', path: '/orders/1', query: {} },
    response: { status: 200, body: { id: 1, status: 'x', total: { amount: '1', currency: 'USD' }, items: [] } },
  };
  const r = verifyInteraction(oas, i);
  assert.ok(r.failures.some((f) => f.check === 'request-required-param'));
});

test('bdcVerify is deterministic', () => {
  assert.deepEqual(bdcVerify(goodOas, pact), bdcVerify(goodOas, pact));
});

test('an empty consumer contract fails closed instead of passing vacuously', () => {
  const empty = {
    consumer: { name: 'empty-consumer' },
    provider: { name: 'paypal-orders' },
    interactions: [],
  };
  const result = bdcVerify(goodOas, empty);
  assert.equal(result.ok, false);
  assert.equal(result.summary.failed, 1);
  assert.ok(canIDeploy(result).reasons.some((r) => r.includes('contract-empty')));
});

test('root-level empty arrays and JSON scalars cannot bypass response type checks', () => {
  const emptyArray = {
    description: 'wrong root array',
    request: { method: 'GET', path: '/orders/1' },
    response: { status: 200, body: [] },
  };
  const arrayResult = verifyInteraction(goodOas, emptyArray);
  assert.equal(arrayResult.ok, false);
  assert.ok(arrayResult.failures.some((failure) =>
    failure.check === 'response-field-type' && failure.detail.includes('$:')));

  const jsonString = {
    description: 'wrong JSON scalar',
    request: { method: 'GET', path: '/orders/1' },
    response: {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: 'opaque',
    },
  };
  const scalarResult = verifyInteraction(goodOas, jsonString);
  assert.equal(scalarResult.ok, false);
  assert.ok(scalarResult.failures.some((failure) => failure.check === 'response-field-type'));
});
