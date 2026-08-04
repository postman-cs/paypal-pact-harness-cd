import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pullWorkspaceOas, requestPostmanJson } from '../scripts/postman/pull-workspace-oas.mjs';
import { canonicalDocumentSha256 } from '../scripts/postman/spec-file.mjs';

const consumerOas = {
  openapi: '3.1.0',
  info: { title: 'Checkout consumer surface', version: '1.2.3' },
  paths: { '/v2/checkout/orders': { post: { responses: { 201: { description: 'created' } } } } },
};
const providerOas = {
  openapi: '3.0.3',
  info: { title: 'PayPal Orders', version: '2.0.0' },
  paths: { '/v2/checkout/orders': { post: { responses: { 201: { description: 'created' } } } } },
};

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function postmanFetch({
  wrongConsumerWorkspace = false,
  ambiguousProviderRoot = false,
  multiFileProvider = false,
  mutatedProvider = false,
} = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.pathname === '/workspaces') {
      const specId = url.searchParams.get('elementId');
      const workspaceId = specId === 'consumer-spec'
        ? (wrongConsumerWorkspace ? 'wrong-workspace' : 'consumer-workspace')
        : 'provider-workspace';
      return jsonResponse({ workspaces: [{ id: workspaceId, name: 'Contracts' }] });
    }
    const files = url.pathname.match(/^\/specs\/(consumer|provider)-spec\/files$/);
    if (files) {
      const role = files[1];
      return jsonResponse({
        files: role === 'provider' && ambiguousProviderRoot
          ? [
              { id: 'root-1', path: 'openapi.json', type: 'ROOT' },
              { id: 'root-2', path: 'other.json', type: 'ROOT' },
            ]
          : role === 'provider' && multiFileProvider
            ? [
                { id: 'root-1', path: 'openapi.json', type: 'ROOT' },
                { id: 'default-1', path: 'components.json', type: 'DEFAULT' },
              ]
          : [{ id: `${role}-root`, path: 'openapi.json', type: 'ROOT' }],
      });
    }
    const file = url.pathname.match(/^\/specs\/(consumer|provider)-spec\/files\/openapi\.json$/);
    if (file) {
      const role = file[1];
      const document = role === 'consumer'
        ? consumerOas
        : mutatedProvider
          ? { ...providerOas, info: { ...providerOas.info, version: 'drifted' } }
          : providerOas;
      return jsonResponse({
        id: `${role}-root`, path: 'openapi.json', type: 'ROOT',
        content: JSON.stringify(document, null, 2),
      });
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  return { calls, fetchImpl };
}

test('both Postman OAS artifacts are workspace-bound, validated, and digest-sealed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-oas-'));
  const { calls, fetchImpl } = postmanFetch();
  const result = await pullWorkspaceOas({
    consumerWorkspaceId: 'consumer-workspace',
    consumerSpecId: 'consumer-spec',
    providerWorkspaceId: 'provider-workspace',
    providerSpecId: 'provider-spec',
    outDir: directory,
    apiKey: 'test-only-key',
    apiBase: 'https://api.postman.com',
    fetchImpl,
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  });

  assert.equal(calls.length, 6);
  assert.ok(calls.every((call) => call.options.headers['x-api-key'] === 'test-only-key'));
  assert.ok(calls.filter((call) => call.url.pathname === '/workspaces').every((call) =>
    call.url.searchParams.get('elementType') === 'specification'));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'consumer-oas.yaml'), 'utf8')), consumerOas);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'provider-oas.yaml'), 'utf8')), providerOas);
  assert.equal(result.artifacts.length, 2);
  assert.ok(result.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  assert.ok(result.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.canonicalSha256)));
  assert.ok(result.artifacts.every((artifact) => artifact.rootFilePath === 'openapi.json'));
  assert.equal(result.retrievedAt, '2026-08-03T00:00:00.000Z');
  assert.deepEqual(JSON.parse(readFileSync(result.manifestPath, 'utf8')), {
    schemaVersion: 1,
    retrievedAt: result.retrievedAt,
    apiBase: 'https://api.postman.com',
    artifacts: result.artifacts,
  });
});

test('Postman OAS retrieval fails when a spec is not in its declared workspace', async () => {
  const { fetchImpl } = postmanFetch({ wrongConsumerWorkspace: true });
  await assert.rejects(
    pullWorkspaceOas({
      consumerWorkspaceId: 'consumer-workspace',
      consumerSpecId: 'consumer-spec',
      providerWorkspaceId: 'provider-workspace',
      providerSpecId: 'provider-spec',
      outDir: mkdtempSync(join(tmpdir(), 'postman-oas-wrong-')),
      apiKey: 'test-only-key',
    apiBase: 'https://api.postman.com',
      fetchImpl,
    }),
    /not in expected workspace consumer-workspace/,
  );
});

test('Postman requests retry 429 responses without logging or returning the API key', async () => {
  let attempts = 0;
  const delays = [];
  const result = await requestPostmanJson('https://api.postman.com/workspaces', {
    apiKey: 'test-only-key',
    fetchImpl: async () => {
      attempts++;
      return attempts === 1
        ? jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '1' })
        : jsonResponse({ workspaces: [] });
    },
    sleepImpl: async (milliseconds) => delays.push(milliseconds),
  });
  assert.deepEqual(result, { workspaces: [] });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1000]);
});

test('consumer and provider bindings cannot point to the same Postman assets', async () => {
  let calls = 0;
  await assert.rejects(
    pullWorkspaceOas({
      consumerWorkspaceId: 'same-workspace',
      consumerSpecId: 'consumer-spec',
      providerWorkspaceId: 'same-workspace',
      providerSpecId: 'provider-spec',
      apiKey: 'test-key',
      fetchImpl: async () => { calls += 1; return jsonResponse({}); },
    }),
    /workspace IDs must be distinct/,
  );
  assert.equal(calls, 0);
});

test('Postman OAS retrieval rejects ambiguous ROOT files before writing artifacts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-oas-ambiguous-'));
  const { fetchImpl } = postmanFetch({ ambiguousProviderRoot: true });
  await assert.rejects(
    pullWorkspaceOas({
      consumerWorkspaceId: 'consumer-workspace',
      consumerSpecId: 'consumer-spec',
      providerWorkspaceId: 'provider-workspace',
      providerSpecId: 'provider-spec',
      outDir: directory,
      apiKey: 'test-only-key',
      fetchImpl,
    }),
    /must have exactly one ROOT file; found 2/,
  );
  assert.equal(existsSync(join(directory, 'consumer-oas.yaml')), false);
  assert.equal(existsSync(join(directory, 'postman-oas-provenance.json')), false);
});

test('Postman OAS retrieval rejects multi-file specs that cannot be pulled as one exact file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-oas-multifile-'));
  const { fetchImpl } = postmanFetch({ multiFileProvider: true });
  await assert.rejects(
    pullWorkspaceOas({
      consumerWorkspaceId: 'consumer-workspace',
      consumerSpecId: 'consumer-spec',
      providerWorkspaceId: 'provider-workspace',
      providerSpecId: 'provider-spec',
      outDir: directory,
      apiKey: 'test-only-key',
      fetchImpl,
    }),
    /must be a single-file specification; found 2 files/,
  );
  assert.equal(existsSync(join(directory, 'postman-oas-provenance.json')), false);
});

test('Postman OAS retrieval fails closed on canonical drift from approved evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-oas-drift-'));
  const { fetchImpl } = postmanFetch({ mutatedProvider: true });
  await assert.rejects(
    pullWorkspaceOas({
      consumerWorkspaceId: 'consumer-workspace',
      consumerSpecId: 'consumer-spec',
      providerWorkspaceId: 'provider-workspace',
      providerSpecId: 'provider-spec',
      consumerExpectedCanonicalSha256: canonicalDocumentSha256(JSON.stringify(consumerOas)),
      providerExpectedCanonicalSha256: canonicalDocumentSha256(JSON.stringify(providerOas)),
      outDir: directory,
      apiKey: 'test-only-key',
      fetchImpl,
    }),
    /provider specification canonical digest drift/,
  );
  assert.equal(existsSync(join(directory, 'provider-oas.yaml')), false);
  assert.equal(existsSync(join(directory, 'postman-oas-provenance.json')), false);
});
