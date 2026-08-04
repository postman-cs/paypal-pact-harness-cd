import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalCollectionSha256 } from '../scripts/postman/collection-canonical.mjs';
import { lockWorkspaceAssets } from '../scripts/postman/lock-workspace-assets.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('asset lock reads customer Postman assets and emits a credential-free sealed binding', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'postman-asset-lock-test-')));
  const outPath = '.contract-handoff/postman-binding.json';
  const consumer = readFileSync('fixtures/paypal/checkout-consumer-oas.json', 'utf8');
  const provider = readFileSync('fixtures/paypal/checkout_orders_v2.json', 'utf8');
  const collection = JSON.parse(readFileSync('fixtures/paypal/orders-lower.postman_collection.json', 'utf8'));
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ method: options.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (url.pathname === '/workspaces') {
      const element = url.searchParams.get('elementId');
      return json({ workspaces: [{ id: element === 'provider-collection' ? 'provider-workspace' : `${element.split('-')[0]}-workspace` }] });
    }
    const list = url.pathname.match(/^\/specs\/(consumer|provider)-spec\/files$/);
    if (list) return json({ files: [{ path: 'openapi.json', type: 'ROOT' }] });
    const file = url.pathname.match(/^\/specs\/(consumer|provider)-spec\/files\/openapi\.json$/);
    if (file) return json({ path: 'openapi.json', type: 'ROOT', content: file[1] === 'consumer' ? consumer : provider });
    if (url.pathname === '/collections/provider-collection') return json({ collection });
    return json({ error: 'not found' }, 404);
  };

  const result = await lockWorkspaceAssets({
    rootDir: root,
    outPath,
    owner: 'paypal-tpe',
    consumerParticipant: 'checkout-consumer',
    consumerWorkspaceId: 'consumer-workspace',
    consumerSpecId: 'consumer-spec',
    providerParticipant: 'paypal-orders',
    providerWorkspaceId: 'provider-workspace',
    providerSpecId: 'provider-spec',
    providerCollectionUid: 'provider-collection',
    apiKey: 'test-key',
    fetchImpl,
    now: () => new Date('2026-08-04T12:00:00.000Z'),
  });
  assert.equal(existsSync(join(root, outPath)), true);
  assert.equal(JSON.parse(readFileSync(join(root, outPath))).customerOwned, true);
  assert.equal(result.binding.owner, 'paypal-tpe');
  assert.equal(result.binding.provider.collection.canonicalSha256, canonicalCollectionSha256(collection));
  assert.match(result.binding.consumer.spec.sourceCanonicalSha256, /^[a-f0-9]{64}$/);
  assert.ok(calls.every(({ method }) => method === 'GET'));
  assert.doesNotMatch(result.content, /test-key|PMAK-|password|token/i);
});

test('asset lock rejects collection/workspace mismatch and never writes output', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'postman-asset-lock-mismatch-')));
  const outPath = '.contract-handoff/postman-binding.json';
  const consumer = readFileSync('fixtures/paypal/checkout-consumer-oas.json', 'utf8');
  const provider = readFileSync('fixtures/paypal/checkout_orders_v2.json', 'utf8');
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/workspaces') {
      const element = url.searchParams.get('elementId');
      return json({ workspaces: [{ id: element === 'provider-collection' ? 'wrong-workspace' : `${element.split('-')[0]}-workspace` }] });
    }
    const list = url.pathname.match(/^\/specs\/(consumer|provider)-spec\/files$/);
    if (list) return json({ files: [{ path: 'openapi.json', type: 'ROOT' }] });
    const file = url.pathname.match(/^\/specs\/(consumer|provider)-spec\/files\/openapi\.json$/);
    if (file) return json({ path: 'openapi.json', type: 'ROOT', content: file[1] === 'consumer' ? consumer : provider });
    return json({});
  };
  await assert.rejects(
    lockWorkspaceAssets({
      rootDir: root, outPath, owner: 'paypal-tpe',
      consumerParticipant: 'checkout-consumer', consumerWorkspaceId: 'consumer-workspace', consumerSpecId: 'consumer-spec',
      providerParticipant: 'paypal-orders', providerWorkspaceId: 'provider-workspace', providerSpecId: 'provider-spec',
      providerCollectionUid: 'provider-collection', apiKey: 'test-key', fetchImpl,
    }),
    /not in expected workspace/,
  );
  assert.equal(existsSync(join(root, outPath)), false);
});
