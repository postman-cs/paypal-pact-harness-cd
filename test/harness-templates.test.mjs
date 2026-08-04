import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = join(ROOT, 'harness');

function yamlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return entry.isFile() && entry.name.endsWith('.yaml') ? [path] : [];
  });
}

function visit(value, callback) {
  if (!value || typeof value !== 'object') return;
  callback(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => visit(item, callback));
    else visit(child, callback);
  }
}

test('every Harness container image is immutable and every KubernetesDirect pod is least privilege', () => {
  for (const file of yamlFiles(HARNESS)) {
    const source = readFileSync(file, 'utf8');
    const document = YAML.parse(source);
    visit(document, (node) => {
      if (typeof node.image === 'string') {
        assert.match(node.image, /@sha256:[a-f0-9]{64}$/, `${file}: mutable image ${node.image}`);
      }
      if (typeof node.command === 'string' && process.platform !== 'win32') {
        const syntax = spawnSync('/bin/sh', ['-n'], { input: node.command, encoding: 'utf8' });
        assert.equal(syntax.status, 0, `${file}: invalid shell command\n${syntax.stderr}`);
      }
      if (node.type === 'KubernetesDirect' && node.spec) {
        assert.equal(node.spec.automountServiceAccountToken, false, `${file}: service account token must not mount`);
        const security = node.spec.containerSecurityContext;
        assert.equal(security?.runAsNonRoot, true, `${file}: KubernetesDirect must run non-root`);
        assert.equal(String(security?.runAsUser), '1000', `${file}: KubernetesDirect must use UID 1000`);
        assert.equal(security?.allowPrivilegeEscalation, false, `${file}: privilege escalation must be disabled`);
        assert.deepEqual(security?.capabilities?.drop, ['ALL'], `${file}: all Linux capabilities must be dropped`);
      }
    });
    assert.doesNotMatch(source, /https?:\/\/[^\s"']*(?:\$\{[^}]*TOKEN|secrets\.getValue)/i,
      `${file}: a secret must not be interpolated into a URL`);
  }
});

test('drop-in Kubernetes stages declare limits and keep Postman CLI installation non-root safe', () => {
  for (const file of yamlFiles(join(HARNESS, 'stages'))) {
    const document = YAML.parse(readFileSync(file, 'utf8'));
    const steps = document.stage.spec.execution.steps;
    for (const entry of steps) {
      if (entry.step.type !== 'Run') continue;
      assert.ok(entry.step.spec.resources?.limits?.memory, `${file}: ${entry.step.identifier} needs memory limit`);
      assert.ok(entry.step.spec.resources?.limits?.cpu, `${file}: ${entry.step.identifier} needs CPU limit`);
    }
  }

  const consumer = readFileSync(join(HARNESS, 'stages', 'consumer-contract-gate.yaml'), 'utf8');
  assert.match(consumer, /postman-cli@1\.45\.0/);
  assert.match(consumer, /--prefix "\$PWD\/\.postman-cli"/);
  assert.match(consumer, /export HOME="\$PWD\/\.ci-home"/);
});

test('customer-owned stage verifies an externally locked bundle and never attests the customer repo as Postman-CS', () => {
  const source = readFileSync(join(HARNESS, 'stages', 'consumer-contract-gate.vendored.yaml'), 'utf8');
  assert.match(source, /cloneCodebase: true/);
  assert.match(source, /\.ci\/verify-pact-harness\.mjs/);
  assert.match(source, /--bundle "\$BUNDLE_PATH"/);
  assert.match(source, /"\$BUNDLE_PATH\/paypal-contract-gate\.mjs" verify/);
  assert.match(source, /postman_collection_path/);
  assert.doesNotMatch(source, /attest-harness-source\.mjs/);
  assert.doesNotMatch(source, /fixtures\/paypal\/orders-lower/);
});

test('complete Harness pipelines pin the repo name and attest origin, commit, and bundle before work', () => {
  const pipelines = [
    'contract-gate.broker.pipeline.yaml',
    'contract-gate.lower.pipeline.yaml',
    'contract-gate.pipeline.yaml',
    'contract-gate.real-consumer.pipeline.yaml',
    'contract-gate.self-test.pipeline.yaml',
  ];
  for (const name of pipelines) {
    const file = join(HARNESS, name);
    const document = YAML.parse(readFileSync(file, 'utf8'));
    assert.equal(document.pipeline.properties.ci.codebase.repoName, 'paypal-pact-harness-cd',
      `${name}: codebase repoName must not be a runtime input`);
    for (const entry of document.pipeline.stages) {
      if (!entry.stage.spec.cloneCodebase) continue;
      const first = entry.stage.spec.execution.steps[0].step;
      assert.equal(first.identifier, 'source_attestation', `${name}: source attestation must run first`);
      assert.equal(first.spec.envVariables.EXPECTED_SOURCE_COMMIT, '<+codebase.commitSha>');
      assert.match(first.spec.command, /attest-harness-source\.mjs/);
    }
  }

  const dropIn = YAML.parse(readFileSync(join(HARNESS, 'stages', 'consumer-contract-gate.yaml'), 'utf8'));
  assert.equal(dropIn.stage.spec.execution.steps[0].step.identifier, 'source_attestation');
});
