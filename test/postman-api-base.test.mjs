import assert from 'node:assert/strict';
import test from 'node:test';
import { postmanApiUrl, validatePostmanApiBase } from '../scripts/postman/postman-api-base.mjs';
import { pullWorkspaceOas, requestPostmanJson } from '../scripts/postman/pull-workspace-oas.mjs';
import { requestJson } from '../scripts/postman/setup-workspace-simulation.mjs';

test('Postman API base accepts only the production API origin', () => {
  assert.equal(validatePostmanApiBase().origin, 'https://api.postman.com');
  assert.equal(postmanApiUrl('/workspaces').href, 'https://api.postman.com/workspaces');
  for (const value of [
    'https://attacker.example',
    'https://api.postman.com.attacker.example',
    'https://api.postman.com:444',
    'https://token@api.postman.com',
    'https://api.postman.com/v1',
    'https://api.postman.com?redirect=evil',
    'file:///tmp/socket',
    'http://127.0.0.1:43123',
    'https://localhost:43123',
  ]) {
    assert.throws(() => validatePostmanApiBase(value), /POSTMAN_API_BASE_URL/);
  }
});

test('a hostile Postman API base is rejected before the API key reaches fetch', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    pullWorkspaceOas({
      consumerWorkspaceId: 'consumer-workspace',
      consumerSpecId: 'consumer-spec',
      providerWorkspaceId: 'provider-workspace',
      providerSpecId: 'provider-spec',
      apiKey: 'PMAK-do-not-exfiltrate',
      apiBase: 'https://attacker.example',
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('must not execute');
      },
    }),
    /must be https:\/\/api\.postman\.com/,
  );
  assert.equal(fetchCalls, 0);
});

test('the low-level requester also blocks key exfiltration and redacts network errors', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    requestPostmanJson('https://attacker.example/workspaces', {
      apiKey: 'PMAK-do-not-exfiltrate',
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response('{}');
      },
    }),
    /POSTMAN_API_BASE_URL/,
  );
  assert.equal(fetchCalls, 0);

  const secret = 'PMAK-network-secret';
  await assert.rejects(
    requestPostmanJson('https://api.postman.com/workspaces', {
      apiKey: secret,
      attempts: 1,
      fetchImpl: async () => { throw new Error(`socket failed for ${secret}`); },
    }),
    (error) => {
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test('the low-level requester rejects nonsensical retry and timeout settings', async () => {
  await assert.rejects(
    requestPostmanJson('https://api.postman.com/workspaces', {
      apiKey: 'test-key', attempts: 0,
    }),
    /attempts must be an integer/,
  );
  await assert.rejects(
    requestPostmanJson('https://api.postman.com/workspaces', {
      apiKey: 'test-key', timeoutMs: -1,
    }),
    /timeoutMs must be an integer/,
  );
});

test('JSON parsing stays inside the timeout, retry, and secret-redaction boundary', async () => {
  const secret = 'PMAK-malformed-body-secret';
  let attempts = 0;
  await assert.rejects(
    requestPostmanJson('https://api.postman.com/workspaces', {
      apiKey: secret,
      attempts: 2,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        attempts += 1;
        return new Response(secret, { status: 200 });
      },
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
  assert.equal(attempts, 2);

  await assert.rejects(
    requestJson('https://api.postman.com/workspaces', {
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

  await assert.rejects(
    requestJson('https://api.postman.com/workspaces', {
      apiKey: secret,
      fetchImpl: async () => new Response(secret, { status: 200 }),
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});
