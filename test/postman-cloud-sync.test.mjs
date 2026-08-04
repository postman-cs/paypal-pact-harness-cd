import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalCollectionSha256 } from '../scripts/postman/collection-canonical.mjs';
import { syncCloudCollection } from '../scripts/postman/sync-cloud-collection.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Postman Cloud sync creates a missing collection in the selected workspace', async () => {
  const calls = [];
  const collection = { info: { name: 'Orders lower' }, item: [] };
  const result = await syncCloudCollection({
    collection,
    workspaceId: 'workspace-1',
    apiKey: 'test-key',
    apiBase: 'https://api.postman.com',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return response({ collections: [] });
      if (calls.length === 2) return response({ collection: { uid: 'user-created' } });
      return response({ collection: { ...collection, info: { ...collection.info, uid: 'user-created' } } });
    },
  });

  assert.equal(result.action, 'created');
  assert.equal(result.uid, 'user-created');
  assert.equal(result.canonicalSha256, canonicalCollectionSha256(collection));
  assert.match(calls[0].url, /workspace=workspace-1/);
  assert.match(calls[0].url, /name=Orders/);
  assert.doesNotMatch(calls[1].url, /[?&]name=/);
  assert.match(calls[1].url, /[?&]workspace=workspace-1/);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(JSON.parse(calls[1].options.body).collection.info.name, 'Orders lower');
});

test('Postman Cloud sync updates the exact-name collection idempotently', async () => {
  const calls = [];
  const collection = { info: { name: 'Orders lower' }, item: [] };
  const result = await syncCloudCollection({
    collection,
    workspaceId: 'workspace-1',
    apiKey: 'test-key',
    apiBase: 'https://api.postman.com',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return response({ collections: [{ name: 'Orders lower', uid: 'user-existing' }] });
      if (calls.length === 2) return response({ collection: { uid: 'user-existing' } });
      return response({ collection: { ...collection, info: { ...collection.info, uid: 'user-existing' } } });
    },
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.uid, 'user-existing');
  assert.match(calls[1].url, /collections\/user-existing$/);
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[2].options.method, 'GET');
});

test('Postman Cloud sync fails closed when the retrieved collection differs semantically', async () => {
  const collection = { info: { name: 'Orders lower' }, item: [] };
  let call = 0;
  await assert.rejects(
    syncCloudCollection({
      collection,
      workspaceId: 'workspace-1',
      apiKey: 'test-key',
      fetchImpl: async () => {
        call += 1;
        if (call === 1) return response({ collections: [] });
        if (call === 2) return response({ collection: { uid: 'user-created' } });
        return response({ collection: { info: { name: 'Changed' }, item: [] } });
      },
    }),
    /Postman collection round-trip canonical digest drift/,
  );
});

test('Postman Cloud sync redacts malformed JSON and times out stalled parsing', async () => {
  const secret = 'PMAK-cloud-json-secret';
  await assert.rejects(
    syncCloudCollection({
      collection: { info: { name: 'Orders lower' }, item: [] },
      workspaceId: 'workspace-1',
      apiKey: secret,
      fetchImpl: async () => new Response(secret, { status: 200 }),
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );

  await assert.rejects(
    syncCloudCollection({
      collection: { info: { name: 'Orders lower' }, item: [] },
      workspaceId: 'workspace-1',
      apiKey: secret,
      timeoutMs: 10,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => new Promise(() => {}),
      }),
    }),
    /timed out after 10ms/,
  );
});

test('a malformed successful Collection list never triggers a create', async () => {
  const methods = [];
  await assert.rejects(
    syncCloudCollection({
      collection: { info: { name: 'Orders lower' }, item: [] },
      workspaceId: 'workspace-1',
      apiKey: 'test-key',
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        return response({ unexpected: true });
      },
    }),
    /collections list response is malformed/,
  );
  assert.deepEqual(methods, ['GET']);
});
