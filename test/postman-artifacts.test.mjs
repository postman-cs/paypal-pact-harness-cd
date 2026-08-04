import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalCollectionSha256 } from '../scripts/postman/collection-canonical.mjs';
import { pullPostmanArtifacts } from '../scripts/postman/pull-artifacts.mjs';
import { canonicalDocumentSha256 } from '../scripts/postman/spec-file.mjs';

const collection = {
  info: { name: 'Checkout consumer' },
  item: [{ name: 'Create order', request: { method: 'POST', url: 'https://example.test/orders' } }],
};
const providerOas = {
  openapi: '3.0.3',
  info: { title: 'Orders', version: '2.32' },
  paths: { '/orders': { post: { responses: { 201: { description: 'created' } } } } },
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function postmanFetch() {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === '/workspaces') {
      return response({
        workspaces: [{
          id: url.searchParams.get('elementType') === 'collection'
            ? 'consumer-workspace'
            : 'provider-workspace',
        }],
      });
    }
    if (url.pathname === '/collections/consumer-collection') return response({ collection });
    if (url.pathname === '/specs/provider-spec/files') {
      return response({ files: [{ id: 'provider-root', path: 'openapi.json', type: 'ROOT' }] });
    }
    if (url.pathname === '/specs/provider-spec/files/openapi.json') {
      return response({
        id: 'provider-root', path: 'openapi.json', type: 'ROOT',
        content: JSON.stringify(providerOas, null, 2),
      });
    }
    return response({ error: 'not found' }, 404);
  };
  return { calls, fetchImpl };
}

test('consumer artifact pull uses the exact workspace-bound provider ROOT file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-artifacts-'));
  const { calls, fetchImpl } = postmanFetch();
  const expected = canonicalDocumentSha256(JSON.stringify(providerOas));
  const result = await pullPostmanArtifacts({
    collectionUid: 'consumer-collection',
    collectionWorkspaceId: 'consumer-workspace',
    specId: 'provider-spec',
    specWorkspaceId: 'provider-workspace',
    expectedCollectionCanonicalSha256: canonicalCollectionSha256(collection),
    expectedSpecCanonicalSha256: expected,
    outDir: directory,
    apiKey: 'test-key',
    fetchImpl,
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  });

  assert.equal(calls.some((url) => url.pathname.endsWith('/definitions')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'provider-oas.yaml'), 'utf8')), providerOas);
  const spec = result.artifacts.find((artifact) => artifact.kind === 'specification');
  const collectionArtifact = result.artifacts.find((artifact) => artifact.kind === 'collection');
  assert.equal(spec.rootFilePath, 'openapi.json');
  assert.equal(spec.canonicalSha256, expected);
  assert.equal(collectionArtifact.canonicalSha256, canonicalCollectionSha256(collection));
  assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, 'utf8')).artifacts, result.artifacts);
});

test('consumer artifact pull writes nothing when approved provider evidence drifts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-artifacts-drift-'));
  const { fetchImpl } = postmanFetch();
  await assert.rejects(
    pullPostmanArtifacts({
      collectionUid: 'consumer-collection',
      collectionWorkspaceId: 'consumer-workspace',
      specId: 'provider-spec',
      specWorkspaceId: 'provider-workspace',
      expectedCollectionCanonicalSha256: canonicalCollectionSha256(collection),
      expectedSpecCanonicalSha256: '0'.repeat(64),
      outDir: directory,
      apiKey: 'test-key',
      fetchImpl,
    }),
    /provider specification canonical digest drift/,
  );
  assert.equal(existsSync(join(directory, 'collection.json')), false);
  assert.equal(existsSync(join(directory, 'provider-oas.yaml')), false);
  assert.equal(existsSync(join(directory, 'postman-artifact-provenance.json')), false);
});

test('consumer artifact pull writes nothing when the approved collection drifts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-artifacts-collection-drift-'));
  const { fetchImpl } = postmanFetch();
  await assert.rejects(
    pullPostmanArtifacts({
      collectionUid: 'consumer-collection',
      collectionWorkspaceId: 'consumer-workspace',
      specId: 'provider-spec',
      specWorkspaceId: 'provider-workspace',
      expectedCollectionCanonicalSha256: '0'.repeat(64),
      expectedSpecCanonicalSha256: canonicalDocumentSha256(JSON.stringify(providerOas)),
      outDir: directory,
      apiKey: 'test-key',
      fetchImpl,
    }),
    /consumer collection canonical digest drift/,
  );
  assert.equal(existsSync(join(directory, 'collection.json')), false);
  assert.equal(existsSync(join(directory, 'provider-oas.yaml')), false);
  assert.equal(existsSync(join(directory, 'postman-artifact-provenance.json')), false);
});
