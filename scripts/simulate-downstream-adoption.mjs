#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attest } from './ci/attest-harness-source.mjs';
import { vendorPactHarness } from './vendor-pact-harness.mjs';
import { bundleDigest } from './verify-vendored-bundle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, '.contract-reports', 'downstream-adoption');

function run(command, args, cwd, { expect = 0 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== expect) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}, expected ${expect}\n` +
      `${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function initRepo(repo, name) {
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', `${name}@example.invalid`);
  git(repo, 'config', 'user.name', `PayPal TPE ${name}`);
}

function commit(repo, message) {
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function install(repo, sourceRoot, sourceCommit, { functionalSnapshot = false } = {}) {
  const target = join(repo, '.ci', 'pact-harness');
  const lock = join(repo, '.ci', 'pact-harness.lock.json');
  if (!functionalSnapshot) {
    vendorPactHarness({
      source: sourceRoot,
      target,
      lock,
      verifier: join(repo, '.ci', 'verify-pact-harness.mjs'),
      expectedCommit: sourceCommit,
    });
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(sourceRoot, 'tools', 'pact-harness'), target, { recursive: true });
  const packageDocument = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  const digest = bundleDigest(target);
  writeFileSync(lock, `${JSON.stringify({
    schemaVersion: 1,
    classification: 'functional-snapshot-not-source-attestation',
    source: {
      baseCommit: sourceCommit,
      includesUncommittedChanges: true,
      attested: false,
    },
    bundle: {
      name: packageDocument.name,
      version: packageDocument.version,
      path: 'pact-harness',
      ...digest,
    },
  }, null, 2)}\n`);
}

function verifyFunctionalSnapshot(repo, { output } = {}) {
  const target = join(repo, '.ci', 'pact-harness');
  const lock = JSON.parse(readFileSync(join(repo, '.ci', 'pact-harness.lock.json'), 'utf8'));
  if (
    lock.classification !== 'functional-snapshot-not-source-attestation' ||
    lock.source?.attested !== false
  ) {
    throw new Error('functional snapshot must be explicitly marked as not source-attested');
  }
  const actual = bundleDigest(target);
  if (actual.files !== lock.bundle?.files || actual.sha256 !== lock.bundle?.sha256) {
    throw new Error('functional snapshot digest mismatch');
  }
  const result = {
    schemaVersion: 1,
    status: 'pass',
    classification: lock.classification,
    sourceAttested: false,
    bundle: actual,
  };
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  return result;
}

function cli(repo) {
  return join(repo, '.ci', 'pact-harness', 'pact-harness.mjs');
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

const temporary = mkdtempSync(join(realpathSync(tmpdir()), 'paypal-tpe-downstream-'));
const sourceSnapshot = join(temporary, 'postman-cs-source');
const consumer = join(temporary, 'consumer-service');
const provider = join(temporary, 'provider-service');
const deployment = join(temporary, 'deployment-pipeline');
const exchange = join(temporary, 'exchange');
const ledger = join(deployment, 'contracts');
const assertions = [];

function pass(name, detail) {
  assertions.push({ name, status: 'pass', detail });
}

try {
  console.log('PHASE 0 — STATIC BDC + GIT LEDGER; NOT THE OFFICIAL PACT BROKER LIFECYCLE');
  for (const directory of [sourceSnapshot, consumer, provider, deployment, exchange, ledger]) {
    mkdirSync(directory, { recursive: true });
  }

  const sourceCommit = git(ROOT, 'rev-parse', 'HEAD');
  const sourceDirty = Boolean(git(ROOT, 'status', '--porcelain', '--untracked-files=all'));
  let sourceRoot = ROOT;
  let source;
  let functionalSnapshot = null;
  if (sourceDirty) {
    // A dirty working tree can exercise current functionality, but it cannot be
    // represented as an attested GitHub checkout. Keep that proof explicitly
    // separate from the production source-attestation path.
    cpSync(ROOT, sourceSnapshot, {
      recursive: true,
      filter: (sourcePath) => {
        const path = relative(ROOT, sourcePath);
        const first = path.split(sep)[0];
        return !['.git', 'node_modules', '.contract-reports', 'dist'].includes(first);
      },
    });
    sourceRoot = sourceSnapshot;
    source = {
      status: 'not-performed',
      reason: 'working tree is dirty; functional snapshot is not source attestation',
      checkoutCommit: sourceCommit,
    };
    functionalSnapshot = {
      classification: 'functional-snapshot-not-source-attestation',
      baseCommit: sourceCommit,
      includesUncommittedChanges: true,
      sourceAttested: false,
    };
    pass('functional-snapshot', `working tree at ${sourceCommit}; not source-attested`);
  } else {
    source = attest({ workspace: ROOT, expectedCommit: sourceCommit, output: null });
    pass('source-attestation', `${source.repository}@${source.commit}`);
  }

  const installOptions = { functionalSnapshot: sourceDirty };
  install(consumer, sourceRoot, sourceCommit, installOptions);
  install(provider, sourceRoot, sourceCommit, installOptions);
  install(deployment, sourceRoot, sourceCommit, installOptions);

  mkdirSync(join(consumer, 'contracts'), { recursive: true });
  mkdirSync(join(consumer, 'api'), { recursive: true });
  mkdirSync(join(consumer, 'inventories'), { recursive: true });
  mkdirSync(join(consumer, 'contract-config'), { recursive: true });
  cpSync(
    join(ROOT, 'fixtures', 'paypal', 'orders-checkout-consumer.postman_collection.json'),
    join(consumer, 'contracts', 'consumer.postman_collection.json'),
  );
  cpSync(join(ROOT, 'fixtures', 'paypal', 'checkout_orders_v2.json'), join(consumer, 'api', 'provider.json'));
  cpSync(
    join(ROOT, 'fixtures', 'paypal', 'orders-spring-routes.json'),
    join(consumer, 'inventories', 'routes.json'),
  );
  cpSync(join(ROOT, 'config', 'subsets', 'orders-demo.json'), join(consumer, 'contract-config', 'subset.json'));
  cpSync(join(ROOT, 'config', 'contract-policy.json'), join(consumer, 'contract-config', 'policy.json'));
  cpSync(join(ROOT, 'config', 'route-exceptions.json'), join(consumer, 'contract-config', 'exceptions.json'));
  writeFileSync(join(consumer, 'paypal-contract-gate.config.json'), `${JSON.stringify({
    schemaVersion: 1,
    environment: 'lower',
    provider: { name: 'paypal-orders', oas: 'api/provider.json', baseline: 'api/provider.json' },
    consumer: { format: 'pact', contract: 'contracts/consumer.pact.json' },
    application: {
      routes: 'inventories/routes.json', actuatorUrl: '', generatedOpenApiUrl: '',
      gatewayInventoryUrl: '', runtimeTrafficUrl: '', stripPrefix: '',
    },
    policy: {
      subset: 'contract-config/subset.json', contract: 'contract-config/policy.json',
      exceptions: 'contract-config/exceptions.json', route: 'block', completeResults: true,
    },
    reports: { directory: '.contract-reports' },
    postman: { enabled: false, collection: '', baseUrl: '', cloud: false },
  }, null, 2)}\n`);
  initRepo(consumer, 'consumer');
  const consumerVersion = commit(consumer, 'Add consumer-owned contract pipeline');
  run(process.execPath, [
    cli(consumer), 'postman-to-pact',
    '--collection', 'contracts/consumer.postman_collection.json',
    '--provider', 'paypal-orders',
    '--consumer', 'orders-checkout-consumer',
    '--out', 'contracts/consumer.pact.json',
  ], consumer);
  if (sourceDirty) {
    verifyFunctionalSnapshot(consumer, {
      output: join(consumer, '.contract-inputs', 'functional-snapshot-verification.json'),
    });
  } else {
    run(process.execPath, [
      join(consumer, '.ci', 'verify-pact-harness.mjs'),
      '--bundle', '.ci/pact-harness', '--lock', '.ci/pact-harness.lock.json',
      '--output', '.contract-inputs/vendored-bundle-attestation.json',
    ], consumer);
  }
  run(process.execPath, [
    join(consumer, '.ci', 'pact-harness', 'paypal-contract-gate.mjs'),
    'doctor', '--config', 'paypal-contract-gate.config.json',
  ], consumer);
  run(process.execPath, [
    join(consumer, '.ci', 'pact-harness', 'paypal-contract-gate.mjs'),
    'verify', '--config', 'paypal-contract-gate.config.json', '--clean',
  ], consumer);
  cpSync(join(consumer, 'contracts', 'consumer.pact.json'), join(exchange, 'consumer.pact.json'));
  pass('portable-bundle-customer-repo', `consumer ${consumerVersion}`);

  mkdirSync(join(provider, 'api'), { recursive: true });
  cpSync(join(ROOT, 'fixtures', 'paypal', 'checkout_orders_v2.json'), join(provider, 'api', 'provider.json'));
  initRepo(provider, 'provider');
  const goodProviderVersion = commit(provider, 'Add compatible provider contract pipeline');

  writeFileSync(join(ledger, '.gitkeep'), '');
  initRepo(deployment, 'deployment');
  commit(deployment, 'Add deployment contract pipeline');
  run(process.execPath, [
    cli(deployment), 'record-deployment', '--ledger', ledger,
    '--pacticipant', 'orders-checkout-consumer', '--version', consumerVersion,
    '--environment', 'lower',
  ], deployment);
  commit(deployment, 'Record lower consumer deployment');

  run(process.execPath, [
    cli(provider), 'record-verification', '--ledger', ledger,
    '--oas', 'api/provider.json', '--pact', join(exchange, 'consumer.pact.json'),
    '--consumer-version', consumerVersion, '--provider-version', goodProviderVersion,
  ], provider);
  commit(deployment, 'Record compatible provider verification');
  run(process.execPath, [
    cli(deployment), 'can-i-deploy', '--ledger', ledger,
    '--pacticipant', 'paypal-orders', '--version', goodProviderVersion, '--to', 'lower',
  ], deployment);
  pass('compatible-provider-pass', goodProviderVersion);

  run(process.execPath, [
    cli(deployment), 'record-deployment', '--ledger', ledger,
    '--pacticipant', 'paypal-orders', '--version', goodProviderVersion, '--environment', 'lower',
  ], deployment);
  commit(deployment, 'Record compatible provider deployment after gate');
  pass('good-deployment-recorded', goodProviderVersion);

  cpSync(
    join(ROOT, 'fixtures', 'paypal', 'checkout_orders_v2.drift.json'),
    join(provider, 'api', 'provider.json'),
  );
  const badProviderVersion = commit(provider, 'Introduce consumer-breaking provider drift');
  run(process.execPath, [
    cli(provider), 'record-verification', '--ledger', ledger,
    '--oas', 'api/provider.json', '--pact', join(exchange, 'consumer.pact.json'),
    '--consumer-version', consumerVersion, '--provider-version', badProviderVersion,
  ], provider);
  commit(deployment, 'Record failed provider verification');
  run(process.execPath, [
    cli(deployment), 'can-i-deploy', '--ledger', ledger,
    '--pacticipant', 'paypal-orders', '--version', badProviderVersion, '--to', 'lower',
  ], deployment, { expect: 1 });
  pass('breaking-provider-blocked', badProviderVersion);

  const environment = JSON.parse(readFileSync(join(ledger, 'environments', 'lower', 'paypal-orders.json')));
  if (environment.version !== goodProviderVersion) {
    throw new Error('blocked provider replaced the last known good lower deployment');
  }
  pass('blocked-version-not-recorded', environment.version);

  const comparator = join(consumer, '.ci', 'pact-harness', 'vendor', 'postman-cs', 'compare-routes.mjs');
  writeFileSync(comparator, `${readFileSync(comparator, 'utf8')}\n// customer acceptance tamper\n`);
  if (sourceDirty) {
    let blocked = false;
    try {
      verifyFunctionalSnapshot(consumer);
    } catch (error) {
      if (!/digest mismatch/.test(error?.message ?? '')) throw error;
      blocked = true;
    }
    if (!blocked) throw new Error('functional snapshot tamper was not rejected');
  } else {
    const tampered = run(process.execPath, [
      join(consumer, '.ci', 'verify-pact-harness.mjs'),
      '--bundle', '.ci/pact-harness', '--lock', '.ci/pact-harness.lock.json',
    ], consumer, { expect: 1 });
    if (!/digest mismatch/.test(tampered.stderr)) throw new Error('tamper failure was not a digest rejection');
  }
  pass('tampered-bundle-blocked', 'full vendored bundle digest mismatch');

  mkdirSync(REPORTS, { recursive: true });
  const summary = {
    schemaVersion: 1,
    phase: 'phase0-static-bdc-git-ledger',
    officialPactBrokerLifecycle: false,
    sourceAttestation: source,
    functionalSnapshot,
    versions: { consumer: consumerVersion, providerGood: goodProviderVersion, providerBad: badProviderVersion },
    assertions,
  };
  writeFileSync(join(REPORTS, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const cases = assertions.map((entry) =>
    `    <testcase classname="paypal-tpe-downstream" name="${escapeXml(entry.name)}">` +
    `<system-out>${escapeXml(entry.detail)}</system-out></testcase>`,
  );
  writeFileSync(join(REPORTS, 'summary.xml'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="paypal-tpe-downstream" tests="${assertions.length}" failures="0">`,
    `  <testsuite name="phase0-static-bdc-git-ledger" tests="${assertions.length}" failures="0">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n'));
  console.log(`[PASS] ${assertions.length} downstream-adoption assertions`);
  console.log(`[evidence] ${REPORTS}`);
} finally {
  if (process.env.KEEP_ADOPTION_TMP === '1') console.log(`[kept] ${temporary}`);
  else rmSync(temporary, { recursive: true, force: true });
}
