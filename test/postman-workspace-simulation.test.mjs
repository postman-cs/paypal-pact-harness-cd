import assert from 'node:assert/strict';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { canonicalCollectionSha256 } from '../scripts/postman/collection-canonical.mjs';
import {
  resolveWorkspaceSimulationOutput,
  runWorkspaceSimulation,
} from '../scripts/postman/run-workspace-simulation.mjs';
import { canonicalDocumentSha256 } from '../scripts/postman/spec-file.mjs';

const PUBLIC_DEMO = {
  classification: 'public-demo',
  owner: 'postman-cs',
  customerOwned: false,
  approvedForPublicEvidence: true,
  approvalReviewedAt: '2026-08-04',
  approvalExpiresAt: '2099-12-31',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('live-shape dual-workspace pull produces two passing compatibility reports', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'postman-live-shape-')));
  const configPath = join(directory, 'bindings.json');
  const outDir = '.contract-reports/postman-workspace-simulation/live-shape';
  const output = join(directory, outDir);
  cpSync('src', join(directory, 'src'), { recursive: true });
  mkdirSync(join(directory, 'node_modules'));
  cpSync('node_modules/yaml', join(directory, 'node_modules', 'yaml'), { recursive: true });
  mkdirSync(join(directory, 'config'));
  copyFileSync('config/contract-policy.json', join(directory, 'config', 'contract-policy.json'));
  const consumerOas = readFileSync('fixtures/paypal/checkout-consumer-oas.json', 'utf8');
  const providerOas = readFileSync('fixtures/paypal/checkout_orders_v2.json', 'utf8');
  const consumerCollection = JSON.parse(readFileSync('fixtures/paypal/orders-checkout-consumer.postman_collection.json', 'utf8'));
  const providerCollection = JSON.parse(readFileSync('fixtures/paypal/orders-lower.postman_collection.json', 'utf8'));
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    ...PUBLIC_DEMO,
    consumer: {
      participant: 'orders-checkout-consumer',
      workspace: { id: 'consumer-workspace' },
      spec: {
        id: 'consumer-spec',
        sourceCanonicalSha256: canonicalDocumentSha256(consumerOas),
      },
      collection: {
        uid: 'user-consumer',
        canonicalSha256: canonicalCollectionSha256(consumerCollection),
      },
    },
    provider: {
      participant: 'paypal-orders',
      workspace: { id: 'provider-workspace' },
      spec: {
        id: 'provider-spec',
        sourceCanonicalSha256: canonicalDocumentSha256(providerOas),
      },
      collection: {
        uid: 'user-provider',
        canonicalSha256: canonicalCollectionSha256(providerCollection),
      },
    },
  }));

  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/workspaces') {
      const id = url.searchParams.get('elementId');
      const workspace = id.includes('consumer') ? 'consumer-workspace' : 'provider-workspace';
      return json({ workspaces: [{ id: workspace }] });
    }
    const files = url.pathname.match(/^\/specs\/(consumer|provider)-spec\/files$/);
    if (files) return json({ files: [{ id: `${files[1]}-root`, path: 'openapi.json', type: 'ROOT' }] });
    const file = url.pathname.match(/^\/specs\/(consumer|provider)-spec\/files\/openapi\.json$/);
    if (file) {
      return json({
        id: `${file[1]}-root`, path: 'openapi.json', type: 'ROOT',
        content: file[1] === 'consumer' ? consumerOas : providerOas,
      });
    }
    if (url.pathname === '/collections/user-consumer') return json({ collection: consumerCollection });
    if (url.pathname === '/collections/user-provider') return json({ collection: providerCollection });
    return json({ error: 'not found' }, 404);
  };

  const evidence = await runWorkspaceSimulation({
    rootDir: directory, configPath, outDir, apiKey: 'test-key', apiBase: 'https://api.postman.com', fetchImpl,
  });
  assert.equal(evidence.collections.length, 2);
  assert.ok(evidence.collections.every((collection) => collection.requests > 0));
  assert.equal(evidence.providerCollectionExecution.status, 'not-run');
  assert.equal(JSON.parse(readFileSync(join(output, 'consumer-oas-bdc.json'))).summary.failed, 0);
  assert.equal(JSON.parse(readFileSync(join(output, 'consumer-collection-bdc.json'))).summary.failed, 0);
  assert.match(readFileSync(join(output, 'consumer-oas-bdc.xml'), 'utf8'), /failures="0"/);
  assert.match(readFileSync(join(output, 'consumer-collection-bdc.xml'), 'utf8'), /failures="0"/);
  assert.equal(JSON.parse(readFileSync(join(output, 'evidence.json'))).classification, 'phase-0 Postman-backed static bi-directional compatibility');
});

test('workspace simulation rejects collection drift before changing report outputs', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'postman-live-shape-drift-')));
  const configPath = join(directory, 'bindings.json');
  const outDir = '.contract-reports/postman-workspace-simulation/drift';
  const output = join(directory, outDir);
  const consumerOas = readFileSync('fixtures/paypal/checkout-consumer-oas.json', 'utf8');
  const providerOas = readFileSync('fixtures/paypal/checkout_orders_v2.json', 'utf8');
  const consumerCollection = JSON.parse(readFileSync('fixtures/paypal/orders-checkout-consumer.postman_collection.json', 'utf8'));
  const providerCollection = JSON.parse(readFileSync('fixtures/paypal/orders-lower.postman_collection.json', 'utf8'));
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    ...PUBLIC_DEMO,
    consumer: {
      participant: 'orders-checkout-consumer',
      workspace: { id: 'consumer-workspace' },
      spec: { id: 'consumer-spec', sourceCanonicalSha256: canonicalDocumentSha256(consumerOas) },
      collection: {
        uid: 'user-consumer',
        canonicalSha256: canonicalCollectionSha256(consumerCollection),
      },
    },
    provider: {
      participant: 'paypal-orders',
      workspace: { id: 'provider-workspace' },
      spec: { id: 'provider-spec', sourceCanonicalSha256: canonicalDocumentSha256(providerOas) },
      collection: { uid: 'user-provider', canonicalSha256: '0'.repeat(64) },
    },
  }));
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'evidence.json'), 'previous-evidence\n');

  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/workspaces') {
      const id = url.searchParams.get('elementId');
      return json({ workspaces: [{ id: id.includes('consumer') ? 'consumer-workspace' : 'provider-workspace' }] });
    }
    if (url.pathname === '/collections/user-consumer') return json({ collection: consumerCollection });
    if (url.pathname === '/collections/user-provider') return json({ collection: providerCollection });
    throw new Error(`unexpected request after collection preflight: ${url.pathname}`);
  };

  await assert.rejects(
    runWorkspaceSimulation({
      rootDir: directory, configPath, outDir, apiKey: 'test-key', fetchImpl,
    }),
    /provider collection canonical digest drift/,
  );
  assert.equal(readFileSync(join(output, 'evidence.json'), 'utf8'), 'previous-evidence\n');
  assert.equal(existsSync(join(output, 'inputs')), false);
});

test('workspace simulation rejects unclassified or expired public bindings before API access', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'postman-binding-classification-')));
  const configPath = join(directory, 'bindings.json');
  let calls = 0;
  for (const metadata of [
    {},
    { ...PUBLIC_DEMO, approvalExpiresAt: '2020-01-01' },
  ]) {
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, ...metadata }));
    await assert.rejects(
      runWorkspaceSimulation({
        rootDir: directory,
        configPath,
        apiKey: 'test-key',
        fetchImpl: async () => { calls += 1; return json({}); },
      }),
      /not approved|approval has expired/,
    );
  }
  assert.equal(calls, 0);
});

test('workspace simulation output is confined to its dedicated report subtree', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'postman-output-path-')));
  const dedicated = join(root, '.contract-reports', 'postman-workspace-simulation');
  assert.equal(
    resolveWorkspaceSimulationOutput(root, '.contract-reports/postman-workspace-simulation'),
    dedicated,
  );
  for (const outDir of [
    '.',
    'src',
    'outside',
    '.contract-reports',
  ]) {
    assert.throws(
      () => resolveWorkspaceSimulationOutput(root, outDir),
      /dedicated subtree/,
    );
  }
  assert.throws(
    () => resolveWorkspaceSimulationOutput(root, dedicated),
    /repository-relative/,
  );
  assert.throws(
    () => resolveWorkspaceSimulationOutput(
      root,
      '.contract-reports/postman-workspace-simulation/../../src',
    ),
    /must not contain path traversal components/,
  );
  assert.throws(
    () => resolveWorkspaceSimulationOutput(root, '../outside'),
    /must not contain path traversal components/,
  );
  assert.throws(
    () => resolveWorkspaceSimulationOutput(
      root,
      '.contract-reports/postman-workspace-simulation/team/../other',
    ),
    /must not contain path traversal components/,
  );
});

test('workspace simulation output rejects symbolic-link destinations', { skip: process.platform === 'win32' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'postman-output-symlink-')));
  const dedicated = join(root, '.contract-reports', 'postman-workspace-simulation');
  const directory = join(dedicated, 'path-test');
  mkdirSync(directory, { recursive: true });
  const link = join(directory, 'linked');
  symlinkSync(join(root, 'src'), link, 'dir');
  try {
    assert.throws(
      () => resolveWorkspaceSimulationOutput(root, relative(root, join(link, 'output'))),
      /symbolic link or symbolic-link parent/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
