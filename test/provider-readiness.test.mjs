import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForProvider } from '../scripts/ci/wait-for-provider.mjs';

test('provider readiness retries bounded failures and sends bearer auth', async () => {
  const requests = [];
  const sleeps = [];
  const responses = [
    new Response('', { status: 503 }),
    new Response('', { status: 200 }),
  ];
  const result = await waitForProvider({
    url: 'https://provider.example.test/ready',
    bearerToken: 'secret-value',
    attempts: 3,
    intervalMs: 1,
    timeoutMs: 100,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return responses.shift();
    },
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.deepEqual(result, { attempts: 2, status: 200 });
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-value');
  assert.deepEqual(sleeps, [1]);
});

test('provider readiness rejects credentials and unsafe schemes before fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('', { status: 200 }); };
  await assert.rejects(
    waitForProvider({ url: 'https://user:secret@provider.example.test/ready', fetchImpl }),
    /credential-free HTTP\(S\)/,
  );
  await assert.rejects(
    waitForProvider({ url: 'file:///etc/passwd', fetchImpl }),
    /credential-free HTTP\(S\)/,
  );
  assert.equal(calls, 0);
});

test('provider readiness fails closed without leaking target or token', async () => {
  const token = 'do-not-log-me';
  const url = 'https://sensitive-provider.example.test/secret/ready';
  await assert.rejects(
    waitForProvider({
      url,
      bearerToken: token,
      attempts: 2,
      intervalMs: 1,
      timeoutMs: 100,
      fetchImpl: async () => { throw new Error(`network failure ${url} ${token}`); },
      sleepImpl: async () => {},
    }),
    (error) => {
      assert.match(error.message, /failed after 2 attempts/);
      assert.doesNotMatch(error.message, /sensitive-provider|do-not-log-me/);
      return true;
    },
  );
});
