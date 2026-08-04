import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightPactBroker } from '../scripts/ci/pact-broker-preflight.mjs';

test('Pact Broker preflight checks the heartbeat and authenticated root without leaking credentials', async () => {
  const requests = [];
  await preflightPactBroker({
    baseUrl: 'https://broker.example.test/pact/',
    username: 'pact',
    password: 'not-for-logs',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.authorization });
      return { ok: true, status: 200 };
    },
  });

  assert.deepEqual(requests.map(({ url }) => url), [
    'https://broker.example.test/pact/diagnostic/status/heartbeat',
    'https://broker.example.test/pact/',
  ]);
  assert.ok(requests.every(({ authorization }) => authorization.startsWith('Basic ')));
  assert.ok(requests.every(({ authorization }) => !authorization.includes('not-for-logs')));
});

test('Pact Broker preflight fails closed on auth errors and network failures', async () => {
  await assert.rejects(
    preflightPactBroker({
      baseUrl: 'https://broker.example.test',
      username: 'pact',
      password: 'secret-value',
      fetchImpl: async (url) => ({ ok: !String(url).endsWith('/'), status: 401 }),
    }),
    (error) => error.message === 'Pact Broker preflight received HTTP 401 from the authenticated root'
      && !error.message.includes('secret-value'),
  );

  await assert.rejects(
    preflightPactBroker({
      baseUrl: 'https://broker.example.test',
      fetchImpl: async () => { throw new Error('secret network detail'); },
    }),
    (error) => error.message === 'Pact Broker preflight could not reach diagnostic/status/heartbeat'
      && !error.message.includes('secret network detail'),
  );
});

test('Pact Broker preflight rejects embedded or partial credentials before fetch', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { ok: true, status: 200 };
  };

  await assert.rejects(
    preflightPactBroker({ baseUrl: 'https://pact:secret@broker.example.test', fetchImpl }),
    /credentials must not be embedded/,
  );
  await assert.rejects(
    preflightPactBroker({ baseUrl: 'https://broker.example.test', username: 'pact', fetchImpl }),
    /username and password must be supplied together/,
  );
  assert.equal(called, false);
});
