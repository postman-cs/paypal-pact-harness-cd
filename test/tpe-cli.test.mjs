import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'paypal-contract-gate.mjs');
const base = JSON.parse(readFileSync(join(ROOT, 'paypal-contract-gate.config.json'), 'utf8'));

function run(args, env = {}) {
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function tempConfig(mutator) {
  mkdirSync(join(ROOT, '.contract-reports'), { recursive: true });
  const directory = mkdtempSync(join(ROOT, '.contract-reports', '.tpe-cli-'));
  const config = structuredClone(base);
  config.reports.directory = `${directory.slice(ROOT.length + 1)}/reports`;
  mutator?.(config);
  const path = join(directory, 'config.json');
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return {
    directory,
    relative: path.slice(ROOT.length + 1),
    reportDirectory: join(directory, 'reports'),
  };
}

test('doctor proves a fresh clone is ready without npm install', () => {
  const result = run(['doctor']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[ok\] Node/);
  assert.match(result.stdout, /\[ok\] Postman-CS postman-cs\/paypal-harness-postman-stages@/);
  assert.match(result.stdout, /\[ready\] node paypal-contract-gate\.mjs verify/);
});

test('one verify command passes and seals complete evidence', () => {
  const config = tempConfig();
  try {
    const result = run(['verify', '--config', config.relative, '--clean']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[PASS\] PayPal contract gate \(lower\)/);
    const summary = JSON.parse(readFileSync(join(config.reportDirectory, 'contract-gate-summary.json')));
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.counts, { total: 5, passed: 5, failed: 0, skipped: 0 });
    const evidence = JSON.parse(readFileSync(join(config.reportDirectory, 'evidence-manifest.json')));
    assert.ok(evidence.files.length >= 11);
    assert.ok(evidence.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  } finally {
    rmSync(config.directory, { recursive: true, force: true });
  }
});

test('rogue application routes fail the simple entry point', () => {
  const config = tempConfig((value) => {
    value.application.routes = 'fixtures/paypal/orders-spring-routes.rogue.json';
  });
  try {
    const result = run(['verify', '--config', config.relative, '--clean']);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}\n${result.stderr}`, /rogue|route parity|route parity and rogue detection/i);
    const route = JSON.parse(readFileSync(join(config.reportDirectory, 'route-contract.json')));
    assert.ok(route.counts.blocking > 0);
    assert.ok(route.rogueInApp.length > 0);
  } finally {
    rmSync(config.directory, { recursive: true, force: true });
  }
});

test('consumer-breaking provider drift and schema diff both fail in one complete run', () => {
  const config = tempConfig((value) => {
    value.provider.oas = 'fixtures/paypal/checkout_orders_v2.drift.json';
  });
  try {
    const result = run(['verify', '--config', config.relative, '--clean']);
    assert.equal(result.status, 1);
    const summary = JSON.parse(readFileSync(join(config.reportDirectory, 'contract-gate-summary.json')));
    assert.equal(summary.counts.total, 5);
    assert.ok(summary.counts.failed >= 2);
    assert.equal(summary.counts.skipped, 0);
    assert.equal(JSON.parse(readFileSync(join(config.reportDirectory, 'consumer-bdc.json'))).deployable, false);
    assert.equal(JSON.parse(readFileSync(join(config.reportDirectory, 'oas-diff.json'))).ok, false);
  } finally {
    rmSync(config.directory, { recursive: true, force: true });
  }
});

test('bail mode stops after the first failure and records every skipped check', () => {
  const config = tempConfig((value) => {
    value.provider.oas = 'fixtures/paypal/checkout_orders_v2.drift.json';
    value.policy.completeResults = false;
  });
  try {
    const result = run(['verify', '--config', config.relative, '--clean']);
    assert.equal(result.status, 1);
    const summary = JSON.parse(readFileSync(join(config.reportDirectory, 'contract-gate-summary.json')));
    assert.equal(summary.mode, 'bail');
    assert.equal(summary.counts.failed, 1);
    assert.ok(summary.counts.skipped > 0);
    assert.equal(summary.counts.total, 5);
  } finally {
    rmSync(config.directory, { recursive: true, force: true });
  }
});

for (const [format, contract] of [
  ['oas', 'fixtures/paypal/checkout-consumer-oas.json'],
  ['postman', 'fixtures/paypal/orders-checkout-consumer.postman_collection.json'],
]) {
  test(`${format} consumer contracts normalize and pass through the simple entry point`, () => {
    const config = tempConfig((value) => {
      value.consumer.format = format;
      value.consumer.contract = contract;
    });
    try {
      const result = run(['verify', '--config', config.relative, '--clean']);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const pact = JSON.parse(readFileSync(join(config.reportDirectory, 'consumer.pact.json')));
      assert.ok(Array.isArray(pact.interactions));
      assert.ok(pact.interactions.length >= 2);
      assert.equal(JSON.parse(readFileSync(join(config.reportDirectory, 'consumer-bdc.json'))).deployable, true);
    } finally {
      rmSync(config.directory, { recursive: true, force: true });
    }
  });
}

test('unsafe configuration and unknown CLI flags fail before running the gate', () => {
  const config = tempConfig((value) => {
    value.environment = 'production';
  });
  try {
    const unsafe = run(['verify', '--config', config.relative]);
    assert.equal(unsafe.status, 2);
    assert.match(unsafe.stderr, /locked to environment=lower/);
    const unknown = run(['doctor', '--wat']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown argument/);
  } finally {
    rmSync(config.directory, { recursive: true, force: true });
  }
});

test('invalid live-inventory retry budgets fail before a network request', () => {
  const result = run(['verify'], {
    PAYPAL_CONTRACT_ACTUATOR_URL: 'http://127.0.0.1:1/actuator/mappings',
    PAYPAL_CONTRACT_OPENAPI_URL: 'http://127.0.0.1:1/v3/api-docs',
    PAYPAL_CONTRACT_INVENTORY_ATTEMPTS: 'unbounded',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /INVENTORY_ATTEMPTS must be an integer from 1 to 120/);
});

test('help is concise and does not load the config', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No npm install is required/);
  assert.doesNotMatch(result.stderr, /FAIL/);
});
