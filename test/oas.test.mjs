import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDoc } from '../src/lib/load.mjs';
import {
  pathMatches, operationFor, schemaTypeAtPath, responseSchemaFor, typeCompatible, parsePath,
} from '../src/lib/oas.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const oas = loadDoc(join(FIX, 'orders-oas.yaml'));

test('pathMatches handles templated segments', () => {
  assert.equal(pathMatches('/orders/{id}', '/orders/123'), true);
  assert.equal(pathMatches('/orders/{id}', '/orders/123/items'), false);
  assert.equal(pathMatches('/orders', '/orders'), true);
  assert.equal(pathMatches('/orders/{id}', '/refunds/123'), false);
});

test('operationFor resolves the concrete request', () => {
  const m = operationFor(oas, 'get', '/orders/999');
  assert.ok(m);
  assert.equal(m.operation.operationId, 'getOrder');
  assert.equal(operationFor(oas, 'delete', '/orders/999'), null);
});

test('parsePath tokenizes props and array items', () => {
  assert.deepEqual(parsePath('$.items[*].sku'), [
    { kind: 'prop', key: 'items' }, { kind: 'item' }, { kind: 'prop', key: 'sku' },
  ]);
  assert.deepEqual(parsePath('$'), []);
});

test('schemaTypeAtPath resolves $refs and nested/array types', () => {
  const schema = responseSchemaFor(oas, operationFor(oas, 'get', '/orders/1').operation, 200);
  assert.deepEqual(schemaTypeAtPath(oas, schema, '$.id'), { found: true, type: 'integer' });
  assert.deepEqual(schemaTypeAtPath(oas, schema, '$.total.amount'), { found: true, type: 'string' });
  assert.deepEqual(schemaTypeAtPath(oas, schema, '$.items[*].sku'), { found: true, type: 'string' });
  assert.equal(schemaTypeAtPath(oas, schema, '$.nope').found, false);
});

test('typeCompatible: integer satisfies number; mismatches rejected', () => {
  assert.equal(typeCompatible('number', 'integer'), true);
  assert.equal(typeCompatible('number', 'number'), true);
  assert.equal(typeCompatible('string', 'integer'), false);
  assert.equal(typeCompatible('null', 'string'), true); // lenient where we can't assert
  assert.equal(typeCompatible('string', 'any'), true);
});
