import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runWorkspaceSimulation } from '../scripts/postman/run-workspace-simulation.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('live-shape dual-workspace pull produces two passing compatibility reports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-live-shape-'));
  const configPath = join(directory, 'bindings.json');
  const outDir = join(directory, 'reports');
  const consumerOas = readFileSync('fixtures/paypal/checkout-consumer-oas.json', 'utf8');
  const providerOas = readFileSync('fixtures/paypal/checkout_orders_v2.json', 'utf8');
  const consumerCollection = JSON.parse(readFileSync('fixtures/paypal/orders-checkout-consumer.postman_collection.json', 'utf8'));
  const providerCollection = JSON.parse(readFileSync('fixtures/paypal/orders-lower.postman_collection.json', 'utf8'));
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    consumer: { participant: 'orders-checkout-consumer', workspace: { id: 'consumer-workspace' }, spec: { id: 'consumer-spec' }, collection: { uid: 'user-consumer' } },
    provider: { participant: 'paypal-orders', workspace: { id: 'provider-workspace' }, spec: { id: 'provider-spec' }, collection: { uid: 'user-provider' } },
  }));

  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/workspaces') {
      const id = url.searchParams.get('elementId');
      const workspace = id.includes('consumer') ? 'consumer-workspace' : 'provider-workspace';
      return json({ workspaces: [{ id: workspace }] });
    }
    if (url.pathname === '/specs/consumer-spec/definitions') return json(consumerOas);
    if (url.pathname === '/specs/provider-spec/definitions') return json(providerOas);
    if (url.pathname === '/collections/user-consumer') return json({ collection: consumerCollection });
    if (url.pathname === '/collections/user-provider') return json({ collection: providerCollection });
    return json({ error: 'not found' }, 404);
  };

  const evidence = await runWorkspaceSimulation({
    rootDir: process.cwd(), configPath, outDir, apiKey: 'test-key', apiBase: 'https://postman.test', fetchImpl,
  });
  assert.equal(evidence.collections.length, 2);
  assert.equal(JSON.parse(readFileSync(join(outDir, 'consumer-oas-bdc.json'))).summary.failed, 0);
  assert.equal(JSON.parse(readFileSync(join(outDir, 'consumer-collection-bdc.json'))).summary.failed, 0);
  assert.match(readFileSync(join(outDir, 'consumer-oas-bdc.xml'), 'utf8'), /failures="0"/);
  assert.match(readFileSync(join(outDir, 'consumer-collection-bdc.xml'), 'utf8'), /failures="0"/);
  assert.equal(JSON.parse(readFileSync(join(outDir, 'evidence.json'))).classification, 'phase-0 Postman-backed static bi-directional compatibility');
});
