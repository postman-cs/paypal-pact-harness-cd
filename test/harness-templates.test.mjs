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

});

test('runtime drop-in stages pull and attest only postman-cs/paypal-pact-harness-cd before contract work', () => {
  const remoteStages = [
    'consumer-contract-gate.yaml',
    'pact-can-i-deploy.yaml',
    'pact-consumer-publish.yaml',
    'pact-provider-verify.yaml',
    'pact-record-deployment.yaml',
    'postman-oas-preflight.yaml',
  ];

  for (const name of remoteStages) {
    const file = join(HARNESS, 'stages', name);
    const source = readFileSync(file, 'utf8');
    const stage = YAML.parse(source).stage;
    const variables = Object.fromEntries(stage.variables.map((variable) => [variable.name, variable]));
    assert.equal(variables.harness_source_connector.value, '<+input>', `${name}: connector must remain a runtime input`);
    assert.equal(variables.harness_source_ref.value, '<+input>.default(main)', `${name}: source ref must default to main`);
    assert.equal(variables.harness_source_commit.value, '<+input>', `${name}: full source commit must be supplied`);

    const [cloneEntry, attestEntry, ...workEntries] = stage.spec.execution.steps;
    const clone = cloneEntry.step;
    assert.equal(clone.type, 'GitClone', `${name}: source checkout must be a native Harness GitClone step`);
    assert.equal(clone.identifier, 'pull_postman_cs_pact_harness');
    assert.equal(clone.spec.connectorRef, '<+stage.variables.harness_source_connector>');
    assert.equal(clone.spec.repoName, 'postman-cs/paypal-pact-harness-cd');
    assert.equal(clone.spec.build.type, 'branch');
    assert.equal(clone.spec.build.spec.branch, '<+stage.variables.harness_source_ref>');
    assert.equal(clone.spec.cloneDirectory, '.pact-harness-source');
    assert.equal(clone.spec.depth, 1);

    const attestation = attestEntry.step;
    assert.equal(attestation.type, 'Run');
    assert.equal(attestation.identifier, 'attest_postman_cs_pact_harness');
    assert.equal(attestation.spec.envVariables.EXPECTED_SOURCE_COMMIT, '<+stage.variables.harness_source_commit>');
    assert.match(attestation.spec.command,
      /(?:cd \.pact-harness-source[\s\S]*node scripts|node \.pact-harness-source\/scripts)\/ci\/attest-harness-source\.mjs/);
    assert.match(attestation.spec.command, /--expected-commit "\$EXPECTED_SOURCE_COMMIT"/);

    assert.ok(workEntries.length > 0, `${name}: contract work must follow source attestation`);
    assert.doesNotMatch(source, /repoName:\s+(?!postman-cs\/paypal-pact-harness-cd)[^\s]+/,
      `${name}: no alternate runtime source repository is allowed`);

    if (name === 'postman-oas-preflight.yaml') {
      assert.equal(variables.contract_policy_path.value,
        '<+input>.default(.pact-harness-source/config/contract-policy.json)');
    }
  }
});
