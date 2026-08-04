import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContractTopology } from '../src/contract-topology.mjs';

test('the committed topology resolves every application/specification edge', () => {
  const topology = JSON.parse(readFileSync(
    new URL('../config/contract-topology.json', import.meta.url),
    'utf8',
  ));
  const result = validateContractTopology(topology);
  assert.equal(result.environment, 'lower');
  assert.deepEqual(result.specsByApplication['orders-spring-wrapper'], ['paypal-orders-v2']);
  assert.deepEqual(
    result.applicationsBySpec['paypal-orders-v2'],
    ['orders-checkout-consumer', 'orders-reporting-consumer', 'orders-spring-wrapper'],
  );
});

test('the topology model supports one-to-many and many-to-many relationships', () => {
  const result = validateContractTopology({
    schemaVersion: 1,
    applications: [{ id: 'app-a' }, { id: 'app-b' }],
    specifications: [{ id: 'spec-1' }, { id: 'spec-2' }],
    relationships: [
      { application: 'app-a', specification: 'spec-1' },
      { application: 'app-a', specification: 'spec-2' },
      { application: 'app-b', specification: 'spec-1' },
      { application: 'app-b', specification: 'spec-2' },
    ],
  });
  assert.deepEqual(result.specsByApplication['app-a'], ['spec-1', 'spec-2']);
  assert.deepEqual(result.applicationsBySpec['spec-1'], ['app-a', 'app-b']);
});

test('topology validation fails on unknown or duplicate edges', () => {
  const base = {
    schemaVersion: 1,
    applications: [{ id: 'app-a' }],
    specifications: [{ id: 'spec-1' }],
  };
  assert.throws(
    () => validateContractTopology({
      ...base,
      relationships: [{ application: 'missing', specification: 'spec-1' }],
    }),
    /unknown application/,
  );
  assert.throws(
    () => validateContractTopology({
      ...base,
      relationships: [
        { application: 'app-a', specification: 'spec-1' },
        { application: 'app-a', specification: 'spec-1' },
      ],
    }),
    /duplicate relationship/,
  );
});
