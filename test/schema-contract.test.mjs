import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDoc } from '../src/lib/load.mjs';
import { validateSchemaValue } from '../src/lib/schema-validate.mjs';
import { auditOas } from '../src/oas-audit.mjs';
import { diffOas } from '../src/oas-diff.mjs';
import { bdcVerify } from '../src/bdc-verify.mjs';
import { validateRouteExceptions } from '../src/route-exceptions.mjs';
import { collectInventories, fetchWithRetry } from '../scripts/collect-route-inventories.mjs';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const orders = loadDoc(join(ROOT, 'fixtures/paypal/checkout_orders_v2.json'));
const drift = loadDoc(join(ROOT, 'fixtures/paypal/checkout_orders_v2.drift.json'));
const subset = loadDoc(join(ROOT, 'config/subsets/orders-demo.json'));
const policy = loadDoc(join(ROOT, 'config/contract-policy.json'));
const pact = loadDoc(join(ROOT, 'fixtures/paypal/orders-consumer.pact.json'));

test('schema validation covers required fields, enum, format, constraints, arrays, and extra properties', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'state', 'items'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      state: { type: 'string', enum: ['CREATED', 'COMPLETED'] },
      items: {
        type: 'array',
        minItems: 1,
        items: { type: 'integer', minimum: 1 },
      },
    },
  };
  const failures = validateSchemaValue({}, schema, {
    id: 'not-a-uuid',
    state: 'UNKNOWN',
    items: [0],
    rogue: true,
  });
  assert.deepEqual(
    new Set(failures.map((failure) => failure.keyword)),
    new Set(['format', 'enum', 'minimum', 'additionalProperties']),
  );
  assert.ok(validateSchemaValue({}, schema, { id: 'a' }).some((failure) => failure.keyword === 'required'));
});

test('the selected PayPal Orders OAS passes security, negative-response, and example audit', () => {
  const result = auditOas(orders, { subset, policy: policy.oasAudit });
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { total: 9, passed: 9, failed: 0 });
});

test('OAS audit fails closed when security or an example becomes invalid', () => {
  const candidate = structuredClone(orders);
  candidate.paths['/v2/checkout/orders/{id}'].get.security = [];
  const response = candidate.components.responses['404_error_response'];
  response.content['application/json'].examples.generic.value.name = 42;
  const result = auditOas(candidate, { subset, policy: policy.oasAudit });
  assert.equal(result.ok, false);
  const checks = result.interactions.flatMap((interaction) => interaction.failures.map((failure) => failure.check));
  assert.ok(checks.includes('security-missing'));
  assert.ok(checks.includes('example-type'));
});

test('schema-level OAS diff passes identical specs and finds the deliberate Orders drift', () => {
  assert.equal(diffOas(orders, structuredClone(orders), { subset }).ok, true);
  const result = diffOas(orders, drift, { subset });
  assert.equal(result.ok, false);
  assert.ok(result.breakingChanges.some((change) =>
    change.check === 'response-property-removed' && change.detail.includes('.status')));
});

test('schema-level OAS diff blocks newly required request fields', () => {
  const candidate = structuredClone(orders);
  const request = candidate.components.schemas.order_request;
  request.required = [...new Set([...(request.required ?? []), 'custom_id'])];
  request.properties.custom_id = { type: 'string' };
  const result = diffOas(orders, candidate, { subset });
  assert.equal(result.ok, false);
  assert.ok(result.breakingChanges.some((change) => change.check === 'request-required-added'));
});

test('consumer policy requires both success and negative interactions', () => {
  assert.equal(bdcVerify(orders, pact, policy.consumer).ok, true);
  const positiveOnly = structuredClone(pact);
  positiveOnly.interactions = positiveOnly.interactions.filter((interaction) => interaction.response.status < 400);
  const result = bdcVerify(orders, positiveOnly, policy.consumer);
  assert.equal(result.ok, false);
  assert.ok(result.interactions.some((interaction) =>
    interaction.failures.some((failure) => failure.check === 'negative-case-missing')));
});

test('route exceptions require governance metadata, environment scope, and a future expiry', () => {
  const now = new Date('2026-07-30T00:00:00Z');
  const good = [{
    kind: 'rogue',
    method: 'GET',
    path: '/v2/checkout/orders/internal',
    reason: 'Temporary migration route',
    ticket: 'PAYPAL-123',
    approvedBy: 'varun@example.test',
    approvedAt: '2026-07-29T00:00:00Z',
    expiresAt: '2026-08-15T00:00:00Z',
    environments: ['lower'],
  }];
  assert.equal(validateRouteExceptions(good, { environment: 'lower', now }).ok, true);
  const expired = structuredClone(good);
  expired[0].expiresAt = '2026-07-29T00:00:00Z';
  const result = validateRouteExceptions(expired, { environment: 'lower', now });
  assert.equal(result.ok, false);
  assert.ok(result.interactions[0].failures.some((failure) => failure.check === 'exception-expired'));
});

test('route inventory collection retries transient failures and records evidence digests', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls === 1
      ? new Response('unavailable', { status: 503 })
      : new Response(JSON.stringify({ paths: { '/v2/checkout/orders': { post: {} } } }), { status: 200 });
  };
  const response = await fetchWithRetry('https://inventory.example.test', {
    attempts: 2,
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.equal(response.status, 200);
  const directory = mkdtempSync(join(tmpdir(), 'route-inventory-'));
  const manifest = await collectInventories([
    { id: 'generated-openapi', kind: 'generated-openapi', url: 'https://inventory.example.test', authoritative: false },
  ], {
    outDir: directory,
    attempts: 1,
    fetchImpl: async () => new Response(JSON.stringify({ paths: {} }), { status: 200 }),
  });
  assert.match(manifest.sources[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'generated-openapi.json'))), { paths: {} });
});
