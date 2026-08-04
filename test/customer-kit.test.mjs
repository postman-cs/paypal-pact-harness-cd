import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
      archive: false,
      allowDirty: true,
    });
    assert.equal(result.manifest.classification, 'customer-confidential operational metadata');
    assert.equal(result.manifest.pipelineVariables.length, 18);
    assert.equal(result.manifest.release.sourceRef, 'v0.6.3');
    assert.ok(result.manifest.files.length > 50);

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

    const verify = runNode(join(output, 'verify-kit.mjs'), output);
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    assert.match(verify.stdout, /customer kit integrity/);
    assert.match(verify.stdout, /Harness runtime coverage 18\/18/);

    const demo = runNode(join(output, 'run-demo.mjs'), output);
    assert.equal(demo.status, 0, demo.stderr || demo.stdout);
    assert.match(demo.stdout, /\[PASS\] PayPal contract gate \(lower\)/);
    assert.equal(existsSync(join(output, 'demo-local/.contract-reports/evidence-manifest.json')), true);

    const tamperPath = join(output, 'demo/expected-first-run.md');
    writeFileSync(tamperPath, `${readFileSync(tamperPath, 'utf8')}\ntampered\n`);
    const tampered = runNode(join(output, 'verify-kit.mjs'), output);
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /(?:byte count|SHA-256) mismatch/);
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
