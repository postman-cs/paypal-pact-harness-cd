import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalCollectionSha256,
  executableCollectionContent,
} from '../scripts/postman/collection-canonical.mjs';

function localCollection() {
  return {
    info: { name: 'Orders' },
    item: [{
      name: 'Get order',
      request: {
        method: 'GET',
        url: {
          raw: 'https://api.example.test/v2/orders/1',
          protocol: 'https',
          host: ['api', 'example', 'test'],
          path: ['v2', 'orders', '1'],
        },
      },
      response: [],
    }],
  };
}

test('collection digest ignores Postman-managed metadata and redundant URL rendering', () => {
  const local = localCollection();
  const retrieved = structuredClone(local);
  retrieved.info.uid = 'user-collection';
  retrieved.info.updatedAt = '2026-08-03T00:00:00Z';
  retrieved.item[0].id = 'request-id';
  retrieved.item[0].createdAt = '2026-08-03T00:00:00Z';
  retrieved.item[0].request.url.raw = '/v2/orders/1';
  retrieved.item[0].response.push({
    id: 'response-id',
    _postman_previewlanguage: 'json',
    responseTime: null,
    cookie: [],
  });
  local.item[0].response.push({});

  assert.equal(canonicalCollectionSha256(retrieved), canonicalCollectionSha256(local));
});

test('collection digest still detects executable request drift', () => {
  const approved = localCollection();
  const changed = structuredClone(approved);
  changed.item[0].request.url.path[2] = '2';

  assert.notEqual(canonicalCollectionSha256(changed), canonicalCollectionSha256(approved));
});

test('collection digest normalizes Postman URL strings and script defaults', () => {
  const local = {
    info: { name: 'Orders' },
    item: [{
      name: 'Get order',
      event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => true);'] } }],
      request: { method: 'GET', url: '{{baseUrl}}/v2/orders/1' },
    }],
  };
  const retrieved = structuredClone(local);
  retrieved.item[0].event[0].script.type = 'text/javascript';
  retrieved.item[0].request.url = {
    raw: '{{baseUrl}}/v2/orders/1',
    host: ['{{baseUrl}}'],
    path: ['v2', 'orders', '1'],
  };
  retrieved.item[0].response = [];

  assert.equal(canonicalCollectionSha256(retrieved), canonicalCollectionSha256(local));
});

test('sealed executable content preserves the canonical digest and runnable templated URL', () => {
  const source = {
    info: { name: 'Orders' },
    item: [{
      name: 'Get order',
      request: { method: 'GET', url: { raw: '{{baseUrl}}/v2/orders/1' } },
    }],
  };
  const executable = JSON.parse(executableCollectionContent(source));
  assert.equal(executable.item[0].request.url, '{{baseUrl}}/v2/orders/1');
  assert.equal(canonicalCollectionSha256(executable), canonicalCollectionSha256(source));
});
