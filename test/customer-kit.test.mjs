import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageCustomerKit } from '../scripts/tpe/package-customer-kit.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function config() {
  return {
    schemaVersion: 1,
    harness: {
      orgIdentifier: 'paypal_tpe',
      projectIdentifier: 'contract_testing',
      inputSetName: 'PayPal Pact Broker lower',
      inputSetIdentifier: 'paypal_pact_broker_lower',
    },
    release: {
      sourceRef: 'v0.6.3',
      reviewedSourceCommit: 'b827040c2fa7640bd71142930aa04ac97fbe90db',
      consumerPactBranch: 'main',
      providerPactBranch: 'main',
    },
    infrastructure: {
      codebaseConnector: 'account.paypal_pact_source',
      containerRegistryConnector: 'account.paypal_contract_registry',
      kubernetesConnector: 'account.paypal_contract_kubernetes',
      kubernetesNamespace: 'paypal-contract-lower',
    },
    broker: {
      baseUrl: 'https://pact-broker.example.test',
      includeWipPactsSince: '2026-07-04',
      targetEnvironment: 'lower',
    },
    postman: { bindingFile: 'config/postman-workspace-simulation.json' },
  };
}

function runNode(path, cwd) {
  return spawnSync(process.execPath, [path], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

test('customer package is self-contained, verifiable, read-only, and runnable without install', () => {
  const parent = join(ROOT, '.contract-handoff', `customer-kit-test-${process.pid}-${Date.now()}`);
  const configPath = join(parent, 'config.json');
  const output = join(parent, 'kit');
  mkdirSync(parent, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config(), null, 2)}\n`);
  try {
    const result = packageCustomerKit({
      rootDir: ROOT,
      configPath: relative(ROOT, configPath),
      outDir: relative(ROOT, output),
      archive: true,
      allowDirty: true,
    });
    assert.equal(result.manifest.classification, 'customer-confidential operational metadata');
    assert.equal(result.manifest.pipelineVariables.length, 18);
    assert.equal(result.manifest.release.sourceRef, 'v0.6.3');
    assert.ok(result.manifest.files.length > 50);
    assert.ok(result.artifact);
    assert.equal(existsSync(result.artifact.archive), true);
    assert.equal(existsSync(result.artifact.checksum), true);
    const archive = readFileSync(result.artifact.archive);
    assert.equal(archive.length, result.artifact.bytes);
    assert.equal(digest(archive), result.artifact.sha256);
    assert.equal(
      readFileSync(result.artifact.checksum, 'utf8'),
      `${result.artifact.sha256}  ${basename(result.artifact.archive)}\n`,
    );

    for (const path of [
      'START-HERE.md',
      'KIT-MANIFEST.json',
      'SHA256SUMS',
      'verify-kit.mjs',
      'run-demo.mjs',
      'demo/harness-pipeline.yaml',
      'demo/harness-input-set.yaml',
      'demo/postman-bindings.json',
      'production/README.md',
      'production/stages/pact-consumer-publish.yaml',
      'production/stages/pact-provider-verify.yaml',
      'production/stages/pact-can-i-deploy.yaml',
      'production/stages/pact-record-deployment.yaml',
      'provenance/release.json',
      'provenance/sbom.cdx.json',
      'toolkit/paypal-contract-gate.mjs',
      'demo-local/paypal-contract-gate.config.json',
    ]) assert.equal(existsSync(join(output, path)), true, path);

    assert.equal(existsSync(join(output, 'toolkit/scripts/postman/setup-workspace-simulation.mjs')), false);
    assert.equal(existsSync(join(output, 'toolkit/scripts/postman/sync-cloud-collection.mjs')), false);
    assert.doesNotMatch(readFileSync(join(output, 'demo/harness-input-set.yaml'), 'utf8'), /REPLACE_|PMAK-|pat\./);

    const extract = join(parent, 'extracted');
    mkdirSync(extract);
    const unpack = spawnSync('tar', ['-xzf', result.artifact.archive, '-C', extract], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr || unpack.stdout);
    const extracted = join(extract, 'kit');

    const verify = runNode(join(extracted, 'verify-kit.mjs'), extracted);
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    assert.match(verify.stdout, /customer kit integrity/);
    assert.match(verify.stdout, /Harness runtime coverage 18\/18/);

    const demo = runNode(join(extracted, 'run-demo.mjs'), extracted);
    assert.equal(demo.status, 0, demo.stderr || demo.stdout);
    assert.match(demo.stdout, /\[PASS\] PayPal contract gate \(lower\)/);
    assert.equal(existsSync(join(extracted, 'demo-local/.contract-reports/evidence-manifest.json')), true);

    const tamperPath = join(extracted, 'demo/expected-first-run.md');
    const tamperOriginal = readFileSync(tamperPath);
    writeFileSync(tamperPath, `${tamperOriginal.toString('utf8')}\ntampered\n`);
    const tampered = runNode(join(extracted, 'verify-kit.mjs'), extracted);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /(?:byte count|SHA-256) mismatch/);

    writeFileSync(tamperPath, tamperOriginal);
    const extraPath = join(extracted, 'unexpected-customer-file.txt');
    writeFileSync(extraPath, 'not in the reviewed manifest\n');
    const extra = runNode(join(extracted, 'verify-kit.mjs'), extracted);
    assert.notEqual(extra.status, 0);
    assert.match(extra.stderr, /kit inventory mismatch/);
    rmSync(extraPath);

    const manifestPath = join(extracted, 'KIT-MANIFEST.json');
    const manifestOriginal = readFileSync(manifestPath, 'utf8');
    const bindingPath = join(extracted, 'demo/postman-bindings.json');
    const bindingOriginal = readFileSync(bindingPath, 'utf8');
    const unsafeBinding = JSON.parse(bindingOriginal);
    unsafeBinding.apiKey = 'opaque-value-that-does-not-look-like-a-secret';
    const unsafeSource = `${JSON.stringify(unsafeBinding, null, 2)}\n`;
    writeFileSync(bindingPath, unsafeSource);
    const unsafeManifest = JSON.parse(manifestOriginal);
    const bindingEntry = unsafeManifest.files.find((entry) => entry.path === 'demo/postman-bindings.json');
    bindingEntry.bytes = Buffer.byteLength(unsafeSource);
    bindingEntry.sha256 = digest(unsafeSource);
    writeFileSync(manifestPath, `${JSON.stringify(unsafeManifest, null, 2)}\n`);
    const credentialField = runNode(join(extracted, 'verify-kit.mjs'), extracted);
    assert.notEqual(credentialField.status, 0);
    assert.match(credentialField.stderr, /forbidden credential field/);

    writeFileSync(bindingPath, bindingOriginal);
    const traversalManifest = JSON.parse(manifestOriginal);
    traversalManifest.files[0].path = '../outside-kit';
    writeFileSync(manifestPath, `${JSON.stringify(traversalManifest, null, 2)}\n`);
    const traversal = runNode(join(extracted, 'verify-kit.mjs'), extracted);
    assert.notEqual(traversal.status, 0);
    assert.match(traversal.stderr, /unsafe manifest path/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('customer-facing template requires customer Harness and Postman ownership', () => {
  const handoff = readFileSync(join(ROOT, 'config/paypal-tpe-handoff.example.json'), 'utf8');
  const binding = readFileSync(join(ROOT, 'config/postman-customer-binding.example.json'), 'utf8');
  assert.match(handoff, /REPLACE_WITH_HARNESS_ORG_IDENTIFIER/);
  assert.match(handoff, /REPLACE_WITH_CONSUMER_WORKSPACE_ID/);
  assert.match(handoff, /REPLACE_WITH_PROVIDER_COLLECTION_UID/);
  assert.doesNotMatch(handoff, /postman-workspace-simulation\.json/);
  assert.match(binding, /REPLACE_WITH_CONSUMER_WORKSPACE_ID/);
  assert.match(binding, /REPLACE_WITH_PROVIDER_COLLECTION_UID/);
  assert.doesNotMatch(binding, /d5576940|f754c8dc|55358385/);
});
