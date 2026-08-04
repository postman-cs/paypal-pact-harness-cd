import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDocumentSha256 } from '../scripts/postman/spec-file.mjs';

test('canonical OAS digests ignore formatting and key order but preserve object-vs-array semantics', () => {
  const left = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Orders', version: '1' },
    paths: {},
    components: { schemas: { anyValue: {} } },
  });
  const reordered = JSON.stringify({
    components: { schemas: { anyValue: {} } },
    paths: {},
    info: { version: '1', title: 'Orders' },
    openapi: '3.0.3',
  }, null, 4);
  const arrayMutation = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Orders', version: '1' },
    paths: {},
    components: { schemas: { anyValue: [] } },
  });

  assert.equal(canonicalDocumentSha256(left), canonicalDocumentSha256(reordered));
  assert.notEqual(canonicalDocumentSha256(left), canonicalDocumentSha256(arrayMutation));
});
