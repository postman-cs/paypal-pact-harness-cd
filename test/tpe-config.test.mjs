import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTpeConfig, parseTpeConfig, validateTpeConfig } from '../src/tpe-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const committed = JSON.parse(readFileSync(join(ROOT, 'paypal-contract-gate.config.json'), 'utf8'));

function clone(value = committed) {
  return structuredClone(value);
}

test('the committed PayPal TPE profile is valid and resolves every input', () => {
  const config = loadTpeConfig('paypal-contract-gate.config.json', { root: ROOT, env: {} });
  assert.equal(config.environment, 'lower');
  assert.equal(config.policy.route, 'block');
  assert.equal(config.policy.completeResults, true);
  assert.equal(config.consumer.format, 'pact');
  assert.match(config.provider.oas.absolute, /checkout_orders_v2\.json$/);
});

test('config parsing reports invalid JSON without exposing file content', () => {
  assert.throws(() => parseTpeConfig('{"token":"secret",', 'bad.json'), /bad\.json is not valid JSON/);
});

test('unknown and misspelled fields fail closed', () => {
  const top = clone();
  top.secert = 'value';
  assert.throws(() => validateTpeConfig(top, { root: ROOT, env: {} }), /unknown field.*secert/);
  const nested = clone();
  nested.application.actuatorURL = 'https://example.test/actuator';
  assert.throws(() => validateTpeConfig(nested, { root: ROOT, env: {} }), /application contains unknown field.*actuatorURL/);
});

test('the first profile cannot target production or an arbitrary environment', () => {
  for (const environment of ['production', 'prod', 'staging', '']) {
    const value = clone();
    value.environment = environment;
    assert.throws(
      () => validateTpeConfig(value, { root: ROOT, env: {} }),
      /locked to environment=lower|environment is required/,
    );
  }
});

test('consumer formats and booleans are strict', () => {
  const format = clone();
  format.consumer.format = 'collection';
  assert.throws(() => validateTpeConfig(format, { root: ROOT, env: {} }), /pact, oas, or postman/);
  const complete = clone();
  complete.policy.completeResults = 'true';
  assert.throws(() => validateTpeConfig(complete, { root: ROOT, env: {} }), /must be true or false/);
});

test('input and report paths cannot be absolute or escape the repository', () => {
  const traversal = clone();
  traversal.provider.oas = '../outside.json';
  assert.throws(() => validateTpeConfig(traversal, { root: ROOT, env: {} }), /escapes the repository root/);
  const absolute = clone();
  absolute.consumer.contract = join(ROOT, 'fixtures/paypal/orders-consumer.pact.json');
  assert.throws(() => validateTpeConfig(absolute, { root: ROOT, env: {} }), /repository-relative/);
  const report = clone();
  report.reports.directory = '../../tmp/reports';
  assert.throws(() => validateTpeConfig(report, { root: ROOT, env: {} }), /escapes the repository root/);
});

test('symlinked inputs cannot escape the repository', { skip: process.platform === 'win32' }, () => {
  const inside = mkdtempSync(join(ROOT, '.tpe-config-'));
  const outside = mkdtempSync(join(tmpdir(), 'paypal-tpe-outside-'));
  try {
    writeFileSync(join(outside, 'provider.json'), '{}\n');
    symlinkSync(join(outside, 'provider.json'), join(inside, 'provider.json'));
    const value = clone();
    value.provider.oas = `${inside.slice(ROOT.length + 1)}/provider.json`;
    assert.throws(() => validateTpeConfig(value, { root: ROOT, env: {} }), /resolves outside/);
  } finally {
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('live Actuator and generated OpenAPI inventory URLs are an inseparable pair', () => {
  const value = clone();
  value.application.actuatorUrl = 'https://lower.example.test/actuator/mappings';
  assert.throws(() => validateTpeConfig(value, { root: ROOT, env: {} }), /must be supplied together/);
  value.application.generatedOpenApiUrl = 'https://lower.example.test/v3/api-docs';
  const config = validateTpeConfig(value, { root: ROOT, env: {} });
  assert.match(config.application.actuatorUrl, /actuator\/mappings/);
  assert.match(config.application.generatedOpenApiUrl, /v3\/api-docs/);
});

test('runtime URL environment overrides take precedence without storing secrets', () => {
  const config = validateTpeConfig(clone(), {
    root: ROOT,
    env: {
      PAYPAL_CONTRACT_ACTUATOR_URL: 'https://runtime.example.test/actuator/mappings',
      PAYPAL_CONTRACT_OPENAPI_URL: 'https://runtime.example.test/v3/api-docs',
    },
  });
  assert.equal(config.application.actuatorUrl, 'https://runtime.example.test/actuator/mappings');
  assert.equal(config.application.generatedOpenApiUrl, 'https://runtime.example.test/v3/api-docs');
});

test('URLs reject embedded credentials and non-http protocols', () => {
  for (const url of ['https://user:password@example.test/api', 'file:///tmp/routes.json', 'javascript:alert(1)']) {
    const value = clone();
    value.application.actuatorUrl = url;
    value.application.generatedOpenApiUrl = 'https://example.test/v3/api-docs';
    assert.throws(() => validateTpeConfig(value, { root: ROOT, env: {} }), /http\(s\).*without embedded credentials|absolute http/);
  }
});

test('Postman runtime checks require an explicit collection and base URL', () => {
  const missing = clone();
  missing.postman.enabled = true;
  missing.postman.collection = '';
  assert.throws(() => validateTpeConfig(missing, { root: ROOT, env: {} }), /postman\.collection is required/);
  const noBase = clone();
  noBase.postman.enabled = true;
  noBase.postman.baseUrl = '';
  assert.throws(() => validateTpeConfig(noBase, { root: ROOT, env: {} }), /postman\.baseUrl is required/);
  const valid = clone();
  valid.postman.enabled = true;
  valid.postman.baseUrl = 'https://lower.example.test';
  assert.equal(validateTpeConfig(valid, { root: ROOT, env: {} }).postman.enabled, true);
});
