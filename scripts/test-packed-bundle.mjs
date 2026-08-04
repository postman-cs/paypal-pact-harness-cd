#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(readFileSync(join(root, 'dist', 'release-metadata.json'), 'utf8'));
if (
  metadata.schemaVersion !== 1 ||
  typeof metadata.filename !== 'string' ||
  basename(metadata.filename) !== metadata.filename ||
  !/^[A-Za-z0-9._-]+\.tgz$/.test(metadata.filename) ||
  !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? '') ||
  !Number.isSafeInteger(metadata.bytes) ||
  metadata.bytes <= 0
) {
  throw new Error('packed bundle release metadata is invalid');
}
const archive = join(root, 'dist', metadata.filename);
const archiveContent = readFileSync(archive);
if (archiveContent.length !== metadata.bytes) {
  throw new Error(`packed bundle byte count mismatch: ${archiveContent.length}`);
}
const actual = createHash('sha256').update(archiveContent).digest('hex');
if (actual !== metadata.sha256) throw new Error(`packed bundle digest mismatch: ${actual}`);
const checksum = readFileSync(join(root, 'dist', 'SHA256SUMS'), 'utf8');
const expectedChecksum = `${metadata.sha256}  ${metadata.filename}\n`;
if (checksum !== expectedChecksum) {
  throw new Error('packed bundle SHA256SUMS differs from release metadata');
}

const temporary = mkdtempSync(join(tmpdir(), 'paypal tpe packed-'));
const extract = join(temporary, 'extract');
const workspace = join(temporary, 'clean workspace');
mkdirSync(extract, { recursive: true });
mkdirSync(workspace, { recursive: true });

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return result;
}

try {
  const unpack = run('tar', ['-xzf', archive, '-C', extract], root);
  if (unpack.status !== 0) throw new Error(unpack.stderr || 'could not extract packed bundle');
  const bundle = join(extract, 'package');
  const inputs = {
    'provider.json': 'fixtures/paypal/checkout_orders_v2.json',
    'consumer.pact.json': 'fixtures/paypal/orders-consumer.pact.json',
    'routes.json': 'fixtures/paypal/orders-spring-routes.json',
    'subset.json': 'config/subsets/orders-demo.json',
    'policy.json': 'config/contract-policy.json',
    'exceptions.json': 'config/route-exceptions.json',
  };
  for (const [name, source] of Object.entries(inputs)) cpSync(join(root, source), join(workspace, name));
  writeFileSync(join(workspace, 'contract-gate.json'), `${JSON.stringify({
    schemaVersion: 1,
    environment: 'lower',
    provider: { name: 'paypal-orders', oas: 'provider.json', baseline: 'provider.json' },
    consumer: { format: 'pact', contract: 'consumer.pact.json' },
    application: {
      routes: 'routes.json',
      actuatorUrl: '',
      generatedOpenApiUrl: '',
      gatewayInventoryUrl: '',
      runtimeTrafficUrl: '',
      stripPrefix: '',
    },
    policy: {
      subset: 'subset.json',
      contract: 'policy.json',
      exceptions: 'exceptions.json',
      route: 'block',
      completeResults: true,
    },
    reports: { directory: '.contract-reports/packed' },
    postman: { enabled: false, collection: '', baseUrl: '', cloud: false },
  }, null, 2)}\n`);

  if (existsSync(join(workspace, 'node_modules'))) throw new Error('clean workspace unexpectedly contains node_modules');
  const entry = join(bundle, 'paypal-contract-gate.mjs');
  const doctor = run(process.execPath, [entry, 'doctor', '--config', 'contract-gate.json'], workspace);
  if (doctor.status !== 0) throw new Error(doctor.stderr || doctor.stdout || 'packed doctor failed');
  const verify = run(process.execPath, [entry, 'verify', '--config', 'contract-gate.json', '--clean'], workspace);
  if (verify.status !== 0) throw new Error(verify.stderr || verify.stdout || 'packed verify failed');
  if (!/\[PASS\] PayPal contract gate/.test(verify.stdout)) throw new Error('packed verify did not report PASS');
  if (!existsSync(join(workspace, '.contract-reports', 'packed', 'evidence-manifest.json'))) throw new Error('packed verify emitted no evidence manifest');

  const comparator = join(bundle, 'vendor', 'postman-cs', 'compare-routes.mjs');
  writeFileSync(comparator, `${readFileSync(comparator, 'utf8')}\n// tampered by package test\n`);
  const tampered = run(process.execPath, [entry, 'doctor', '--config', 'contract-gate.json'], workspace);
  if (tampered.status === 0 || !/digest mismatch/.test(tampered.stderr)) {
    throw new Error('packed doctor did not fail closed on a tampered Postman-CS comparator');
  }
  console.log(`packed bundle passed clean-workspace, space-in-path, evidence, and tamper tests (${metadata.filename})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
