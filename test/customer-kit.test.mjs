import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
      baseUrl: 'https://pact-broker.paypal.com',
      approvedHostname: 'pact-broker.paypal.com',
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

function walk(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (name === 'KIT-MANIFEST.json') return [];
    if (entry.isDirectory()) return walk(root, name);
    return entry.isFile() ? [name] : [];
  }).sort();
}

function rewriteIntegrity(root) {
  const manifestPath = join(root, 'KIT-MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const primary = walk(root).filter((name) => name !== 'SHA256SUMS').map((name) => {
    const content = readFileSync(join(root, name));
    return { path: name, bytes: content.length, sha256: digest(content) };
  });
  writeFileSync(join(root, 'SHA256SUMS'), primary.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n');
  manifest.files = walk(root).map((name) => {
    const content = readFileSync(join(root, name));
    return { path: name, bytes: content.length, sha256: digest(content) };
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function refreshManifestEntry(root, name) {
  const manifestPath = join(root, 'KIT-MANIFEST.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const content = readFileSync(join(root, name));
  const entry = manifest.files.find((candidate) => candidate.path === name);
  entry.bytes = content.length;
  entry.sha256 = digest(content);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function attackCopy(source, parent, name) {
  const target = join(parent, name);
  cpSync(source, target, { recursive: true });
  return target;
}

function chmodTree(root, directoryMode, fileMode) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isDirectory()) chmodTree(target, directoryMode, fileMode);
    else if (entry.isFile()) chmodSync(target, fileMode);
  }
  chmodSync(root, directoryMode);
}

function mode(path) {
  return statSync(path).mode & 0o777;
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
      allowSourceMismatch: true,
    });
    assert.equal(result.manifest.classification, 'customer-confidential operational metadata');
    assert.equal(result.manifest.pipelineVariables.length, 18);
    assert.equal(result.manifest.release.sourceRef, 'v0.6.3');
    assert.ok(result.manifest.files.length > 50);
    assert.ok(result.artifact);
    assert.equal(existsSync(result.artifact.archive), true);
    assert.equal(existsSync(result.artifact.checksum), true);
    assert.equal(existsSync(result.artifact.delivery), true);
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
      'first-run.mjs',
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

    assert.equal(existsSync(join(output, 'toolkit/scripts')), false);
    assert.doesNotMatch(readFileSync(join(output, 'demo/harness-input-set.yaml'), 'utf8'), /REPLACE_|PMAK-|pat\./);
    assert.match(readFileSync(join(output, 'demo/harness-pipeline.yaml'), 'utf8'), /^  orgIdentifier: paypal_tpe$/m);
    assert.match(readFileSync(join(output, 'demo/harness-pipeline.yaml'), 'utf8'), /^  projectIdentifier: contract_testing$/m);
    assert.match(readFileSync(result.artifact.delivery, 'utf8'), /node first-run\.mjs/);
    assert.match(readFileSync(result.artifact.delivery, 'utf8'), /Set-Location/);
    if (process.platform !== 'win32') {
      assert.equal(mode(join(ROOT, '.contract-handoff')), 0o700);
      assert.equal(mode(parent), 0o700);
      assert.equal(mode(configPath), 0o600);
      assert.equal(mode(output), 0o700);
      assert.equal(mode(join(output, 'provenance/customer-handoff-config.json')), 0o600);
      assert.equal(mode(result.artifact.archive), 0o600);
      assert.equal(mode(result.artifact.checksum), 0o600);
      assert.equal(mode(result.artifact.delivery), 0o600);
    }

    const extract = join(parent, 'extracted');
    mkdirSync(extract);
    const unpack = spawnSync('tar', ['-xzf', result.artifact.archive, '-C', extract], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr || unpack.stdout);
    const extracted = join(extract, 'kit');

    const verify = runNode(join(extracted, 'verify-kit.mjs'), extracted);
    assert.equal(verify.status, 0, verify.stderr || verify.stdout);
    assert.match(verify.stdout, /customer kit integrity/);
    assert.match(verify.stdout, /Harness runtime coverage 18\/18/);

    const firstRun = runNode(join(extracted, 'first-run.mjs'), extracted);
    assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
    assert.match(firstRun.stdout, /\[PASS\] Delivery integrity/);
    assert.match(firstRun.stdout, /\[PASS\] PayPal contract gate \(lower\)/);
    const evidence = firstRun.stdout.match(/^\[EVIDENCE\] (.+)$/m)?.[1];
    assert.ok(evidence, firstRun.stdout);
    assert.equal(existsSync(join(evidence, 'evidence-manifest.json')), true);
    assert.equal(existsSync(join(extracted, 'demo-local/.contract-reports')), false);
    const afterRun = runNode(join(extracted, 'verify-kit.mjs'), extracted);
    assert.equal(afterRun.status, 0, afterRun.stderr || afterRun.stdout);
    rmSync(evidence, { recursive: true, force: true });

    if (process.platform !== 'win32') {
      const readOnly = attackCopy(extracted, parent, 'read-only-kit');
      chmodTree(readOnly, 0o555, 0o444);
      const readOnlyRun = runNode(join(readOnly, 'first-run.mjs'), readOnly);
      assert.equal(readOnlyRun.status, 0, readOnlyRun.stderr || readOnlyRun.stdout);
      const readOnlyEvidence = readOnlyRun.stdout.match(/^\[EVIDENCE\] (.+)$/m)?.[1];
      assert.ok(readOnlyEvidence);
      assert.equal(existsSync(join(readOnly, 'demo-local/.contract-reports')), false);
      rmSync(readOnlyEvidence, { recursive: true, force: true });
      chmodTree(readOnly, 0o700, 0o600);
    }

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

    const unsafeKit = attackCopy(extracted, parent, 'unsafe-field-kit');
    const unsafeBindingPath = join(unsafeKit, 'demo/postman-bindings.json');
    const unsafeBinding = JSON.parse(readFileSync(unsafeBindingPath, 'utf8'));
    unsafeBinding.apiKey = 'opaque-value-that-does-not-look-like-a-secret';
    writeFileSync(unsafeBindingPath, `${JSON.stringify(unsafeBinding, null, 2)}\n`);
    rewriteIntegrity(unsafeKit);
    const credentialField = runNode(join(unsafeKit, 'verify-kit.mjs'), unsafeKit);
    assert.notEqual(credentialField.status, 0);
    assert.match(credentialField.stderr, /forbidden credential field/);

    const traversalKit = attackCopy(extracted, parent, 'traversal-kit');
    const traversalManifestPath = join(traversalKit, 'KIT-MANIFEST.json');
    const traversalManifest = JSON.parse(readFileSync(traversalManifestPath, 'utf8'));
    traversalManifest.files[0].path = '../outside-kit';
    writeFileSync(traversalManifestPath, `${JSON.stringify(traversalManifest, null, 2)}\n`);
    const traversal = runNode(join(traversalKit, 'verify-kit.mjs'), traversalKit);
    assert.notEqual(traversal.status, 0);
    assert.match(traversal.stderr, /unsafe manifest path/);

    const staleChecksumKit = attackCopy(extracted, parent, 'stale-checksum-kit');
    const stalePath = 'demo/expected-first-run.md';
    writeFileSync(join(staleChecksumKit, stalePath), 'changed while checksum inventory stayed stale\n');
    refreshManifestEntry(staleChecksumKit, stalePath);
    const staleChecksum = runNode(join(staleChecksumKit, 'verify-kit.mjs'), staleChecksumKit);
    assert.notEqual(staleChecksum.status, 0);
    assert.match(staleChecksum.stderr, /SHA256SUMS contradicts the manifest/);

    const bindingDriftKit = attackCopy(extracted, parent, 'binding-drift-kit');
    const driftBindingPath = join(bindingDriftKit, 'demo/postman-bindings.json');
    const driftBinding = JSON.parse(readFileSync(driftBindingPath, 'utf8'));
    const oldWorkspace = driftBinding.consumer.workspace.id;
    driftBinding.consumer.workspace.id = 'coordinated-consumer-workspace-drift';
    writeFileSync(driftBindingPath, `${JSON.stringify(driftBinding, null, 2)}\n`);
    const driftInputPath = join(bindingDriftKit, 'demo/harness-input-set.yaml');
    writeFileSync(
      driftInputPath,
      readFileSync(driftInputPath, 'utf8').replaceAll(oldWorkspace, driftBinding.consumer.workspace.id),
    );
    const bindingDriftManifestPath = join(bindingDriftKit, 'KIT-MANIFEST.json');
    const bindingDriftManifest = JSON.parse(readFileSync(bindingDriftManifestPath, 'utf8'));
    bindingDriftManifest.postmanBindingSha256 = digest(`${JSON.stringify(driftBinding)}\n`);
    writeFileSync(bindingDriftManifestPath, `${JSON.stringify(bindingDriftManifest, null, 2)}\n`);
    rewriteIntegrity(bindingDriftKit);
    const bindingDrift = runNode(join(bindingDriftKit, 'verify-kit.mjs'), bindingDriftKit);
    assert.notEqual(bindingDrift.status, 0);
    assert.match(bindingDrift.stderr, /resolved handoff configuration and Postman binding disagree/);

    const harnessDriftKit = attackCopy(extracted, parent, 'harness-drift-kit');
    for (const name of ['demo/harness-pipeline.yaml', 'demo/harness-input-set.yaml']) {
      const path = join(harnessDriftKit, name);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('paypal_tpe', 'coordinated_org'));
    }
    const harnessManifestPath = join(harnessDriftKit, 'KIT-MANIFEST.json');
    const harnessManifest = JSON.parse(readFileSync(harnessManifestPath, 'utf8'));
    harnessManifest.harness.orgIdentifier = 'coordinated_org';
    writeFileSync(harnessManifestPath, `${JSON.stringify(harnessManifest, null, 2)}\n`);
    rewriteIntegrity(harnessDriftKit);
    const harnessDrift = runNode(join(harnessDriftKit, 'verify-kit.mjs'), harnessDriftKit);
    assert.notEqual(harnessDrift.status, 0);
    assert.match(harnessDrift.stderr, /resolved handoff configuration disagrees/);

    const releaseDriftKit = attackCopy(extracted, parent, 'release-drift-kit');
    const releaseInputPath = join(releaseDriftKit, 'demo/harness-input-set.yaml');
    writeFileSync(releaseInputPath, readFileSync(releaseInputPath, 'utf8').replaceAll('v0.6.3', 'v9.9.9'));
    const releaseProvenancePath = join(releaseDriftKit, 'provenance/release.json');
    const releaseProvenance = JSON.parse(readFileSync(releaseProvenancePath, 'utf8'));
    releaseProvenance.runtimeRelease.sourceRef = 'v9.9.9';
    writeFileSync(releaseProvenancePath, `${JSON.stringify(releaseProvenance, null, 2)}\n`);
    const releaseManifestPath = join(releaseDriftKit, 'KIT-MANIFEST.json');
    const releaseManifest = JSON.parse(readFileSync(releaseManifestPath, 'utf8'));
    releaseManifest.release.sourceRef = 'v9.9.9';
    writeFileSync(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`);
    rewriteIntegrity(releaseDriftKit);
    const releaseDrift = runNode(join(releaseDriftKit, 'verify-kit.mjs'), releaseDriftKit);
    assert.notEqual(releaseDrift.status, 0);
    assert.match(releaseDrift.stderr, /resolved handoff configuration disagrees/);

    const emptyConfigKit = attackCopy(extracted, parent, 'empty-config-kit');
    const emptyConfigPath = join(emptyConfigKit, 'provenance/customer-handoff-config.json');
    writeFileSync(emptyConfigPath, '{}\n');
    const emptyConfigManifestPath = join(emptyConfigKit, 'KIT-MANIFEST.json');
    const emptyConfigManifest = JSON.parse(readFileSync(emptyConfigManifestPath, 'utf8'));
    emptyConfigManifest.handoffConfigSha256 = digest('{}\n');
    writeFileSync(emptyConfigManifestPath, `${JSON.stringify(emptyConfigManifest, null, 2)}\n`);
    rewriteIntegrity(emptyConfigKit);
    const emptyConfig = runNode(join(emptyConfigKit, 'verify-kit.mjs'), emptyConfigKit);
    assert.notEqual(emptyConfig.status, 0);
    assert.match(emptyConfig.stderr, /handoff config Broker URL is invalid|resolved handoff configuration/);

    const secretKit = attackCopy(extracted, parent, 'secret-kit');
    writeFileSync(join(secretKit, 'credential.sh'), 'ghp_123456789012345678901234567890\nASIA1234567890ABCDEF\n');
    rewriteIntegrity(secretKit);
    const secret = runNode(join(secretKit, 'verify-kit.mjs'), secretKit);
    assert.notEqual(secret.status, 0);
    assert.match(secret.stderr, /credential-shaped value detected: credential\.sh/);

    const renamedMutatorKit = attackCopy(extracted, parent, 'renamed-mutator-kit');
    mkdirSync(join(renamedMutatorKit, 'toolkit/scripts'), { recursive: true });
    cpSync(
      join(ROOT, 'scripts/postman/sync-cloud-collection.mjs'),
      join(renamedMutatorKit, 'toolkit/scripts/update-postman-cloud.mjs'),
    );
    rewriteIntegrity(renamedMutatorKit);
    const renamedMutator = runNode(join(renamedMutatorKit, 'verify-kit.mjs'), renamedMutatorKit);
    assert.notEqual(renamedMutator.status, 0);
    assert.match(renamedMutator.stderr, /outside the customer capability allowlist/);

    if (process.platform !== 'win32') {
      const symlinkKit = attackCopy(extracted, parent, 'symlink-kit');
      const reportDir = join(symlinkKit, '.contract-reports');
      mkdirSync(reportDir);
      symlinkSync(tmpdir(), join(reportDir, 'escaped'), 'dir');
      const symlink = runNode(join(symlinkKit, 'verify-kit.mjs'), symlinkKit);
      assert.notEqual(symlink.status, 0);
      assert.match(symlink.stderr, /symbolic links are not allowed/);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('customer-facing template requires customer Harness and Postman ownership', () => {
  const handoff = readFileSync(join(ROOT, 'config/paypal-tpe-handoff.example.json'), 'utf8');
  const binding = readFileSync(join(ROOT, 'config/postman-customer-binding.example.json'), 'utf8');
  assert.match(handoff, /REPLACE_WITH_HARNESS_ORG_IDENTIFIER/);
  assert.match(handoff, /REPLACE_WITH_VERSIONED_RELEASE_TAG/);
  assert.match(handoff, /REPLACE_WITH_REVIEWED_40_CHARACTER_COMMIT/);
  assert.match(handoff, /REPLACE_WITH_CONSUMER_WORKSPACE_ID/);
  assert.match(handoff, /REPLACE_WITH_PROVIDER_COLLECTION_UID/);
  assert.doesNotMatch(handoff, /postman-workspace-simulation\.json/);
  assert.match(binding, /REPLACE_WITH_CONSUMER_WORKSPACE_ID/);
  assert.match(binding, /REPLACE_WITH_PROVIDER_COLLECTION_UID/);
  assert.doesNotMatch(binding, /d5576940|f754c8dc|55358385/);
});

test('customer packaging rejects symbolic-link output ancestors', { skip: process.platform === 'win32' }, () => {
  const parent = join(ROOT, '.contract-handoff', `customer-kit-symlink-${process.pid}-${Date.now()}`);
  const outside = mkdtempSync(join(tmpdir(), 'customer-kit-escape-'));
  const configPath = join(parent, 'config.json');
  const link = join(parent, 'escape-link');
  mkdirSync(parent, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config(), null, 2)}\n`);
  symlinkSync(outside, link, 'dir');
  try {
    assert.throws(
      () => packageCustomerKit({
        rootDir: ROOT,
        configPath: relative(ROOT, configPath),
        outDir: relative(ROOT, join(link, 'escaped-kit')),
        archive: false,
        allowDirty: true,
        allowSourceMismatch: true,
      }),
      /symbolic-link ancestor/,
    );
    assert.equal(existsSync(join(outside, 'escaped-kit')), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('customer packaging cannot label a newer checkout as an older reviewed release', () => {
  const parent = join(ROOT, '.contract-handoff', `customer-kit-release-mismatch-${process.pid}-${Date.now()}`);
  const configPath = join(parent, 'config.json');
  mkdirSync(parent, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config(), null, 2)}\n`);
  try {
    assert.throws(
      () => packageCustomerKit({
        rootDir: ROOT,
        configPath: relative(ROOT, configPath),
        outDir: relative(ROOT, join(parent, 'kit')),
        archive: false,
        allowDirty: true,
      }),
      /does not match reviewed release commit/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('public workflows cannot upload configured customer handoff artifacts', () => {
  const workflows = readdirSync(join(ROOT, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => readFileSync(join(ROOT, '.github/workflows', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(workflows, /customer-confidential|\.contract-handoff/);
  const guide = readFileSync(join(ROOT, 'docs/CUSTOMER-HANDOFF-KIT.md'), 'utf8');
  assert.match(guide, /Never upload a configured kit/);
  assert.match(guide, /Public releases may contain only the generic/);
});
