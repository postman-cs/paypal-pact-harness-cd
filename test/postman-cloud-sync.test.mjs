import assert from 'node:assert/strict';
import test from 'node:test';
import { syncCloudCollection } from '../scripts/postman/sync-cloud-collection.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Postman Cloud sync creates a missing collection in the selected workspace', async () => {
  const calls = [];
  const result = await syncCloudCollection({
    collection: { info: { name: 'Orders lower' }, item: [] },
    workspaceId: 'workspace-1',
    apiKey: 'test-key',
    apiBase: 'https://postman.test',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1
        ? response({ collections: [] })
        : response({ collection: { uid: 'user-created' } });
    },
  });

  assert.equal(result.action, 'created');
  assert.equal(result.uid, 'user-created');
  assert.match(calls[0].url, /workspace=workspace-1/);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(JSON.parse(calls[1].options.body).collection.info.name, 'Orders lower');
});

test('Postman Cloud sync updates the exact-name collection idempotently', async () => {
  const calls = [];
  const result = await syncCloudCollection({
    collection: { info: { name: 'Orders lower' }, item: [] },
    workspaceId: 'workspace-1',
    apiKey: 'test-key',
    apiBase: 'https://postman.test',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1
        ? response({ collections: [{ name: 'Orders lower', uid: 'user-existing' }] })
        : response({ collection: { uid: 'user-existing' } });
    },
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.uid, 'user-existing');
  assert.match(calls[1].url, /collections\/user-existing$/);
  assert.equal(calls[1].options.method, 'PUT');
});
