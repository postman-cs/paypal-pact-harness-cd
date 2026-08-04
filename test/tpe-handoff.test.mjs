import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  PIPELINE_VARIABLES,
  SECRET_IDENTIFIERS,
  prepareHandoff,
  renderHarnessInputSet,
  renderHarnessPipeline,
  validateHandoffConfig,
  verifyReleaseTag,
} from '../scripts/tpe/prepare-handoff.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function config() {
  return {
    schemaVersion: 1,
    harness: {
      orgIdentifier: 'default',
      projectIdentifier: 'default_project',
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

test('handoff renderer covers every Broker runtime variable from one secret-free config', () => {
  const model = validateHandoffConfig(config(), { rootDir: ROOT });
  assert.equal(verifyReleaseTag(model, { rootDir: ROOT }), model.release.reviewedSourceCommit);
  const source = renderHarnessInputSet(model);
  const inputSet = YAML.parse(source).inputSet;
  const values = Object.fromEntries(inputSet.pipeline.variables.map((entry) => [entry.name, entry.value]));
  const pipeline = YAML.parse(readFileSync(join(ROOT, 'harness/contract-gate.broker.pipeline.yaml'), 'utf8')).pipeline;
  const expected = pipeline.variables.map((entry) => entry.name);

  assert.deepEqual(Object.keys(values), PIPELINE_VARIABLES);
  assert.deepEqual(PIPELINE_VARIABLES, expected);
  assert.equal(inputSet.pipeline.properties.ci.codebase.build.type, 'tag');
  assert.equal(inputSet.pipeline.properties.ci.codebase.build.spec.tag, 'v0.6.3');
  assert.equal(values.CONSUMER_WORKSPACE_ID, 'd5576940-9307-447d-91df-70b5fbb33e03');
  assert.equal(values.PROVIDER_COLLECTION_UID, '55358385-070f346f-4c4b-4621-8871-908ceb21341d');
  assert.equal(values.REVIEWED_SOURCE_COMMIT, model.release.reviewedSourceCommit);
  const renderedPipeline = YAML.parse(renderHarnessPipeline(model, { rootDir: ROOT })).pipeline;
  assert.equal(renderedPipeline.orgIdentifier, model.harness.orgIdentifier);
  assert.equal(renderedPipeline.projectIdentifier, model.harness.projectIdentifier);
  assert.doesNotMatch(source, /secrets\.getValue|PMAK-|password|token/i);
  for (const secret of SECRET_IDENTIFIERS) assert.doesNotMatch(source, new RegExp(secret));
});

test('handoff accepts one-file customer configuration with an inline Postman asset lock', () => {
  const inline = config();
  const binding = JSON.parse(readFileSync(join(ROOT, inline.postman.bindingFile), 'utf8'));
  inline.postman = { binding };
  const model = validateHandoffConfig(inline, { rootDir: ROOT });
  assert.equal(model.bindingFile, null);
  assert.equal(model.bindingSource, 'inline handoff config');
  assert.equal(model.binding.provider.collection.uid, binding.provider.collection.uid);
  assert.match(renderHarnessInputSet(model), /PROVIDER_COLLECTION_UID/);
});

test('handoff preparation is all-or-nothing unless replacement is explicit', () => {
  const output = join(ROOT, '.contract-handoff', `atomicity-${process.pid}-${Date.now()}`);
  mkdirSync(output, { recursive: true });
  const relativeOutput = relative(ROOT, output);
  try {
    writeFileSync(join(output, 'config.json'), `${JSON.stringify(config())}\n`);
    writeFileSync(join(output, 'README.md'), 'operator-owned\n');
    assert.throws(
      () => prepareHandoff({
        rootDir: ROOT,
        configPath: `${relativeOutput}/config.json`,
        outDir: relativeOutput,
      }),
      /already exists/,
    );
    assert.equal(existsSync(join(output, 'paypal_pact_broker_lower.input-set.yaml')), false);
    assert.equal(existsSync(join(output, 'paypal_postman_pact_broker_lower.pipeline.yaml')), false);
    assert.equal(readFileSync(join(output, 'README.md'), 'utf8'), 'operator-owned\n');
    if (process.platform !== 'win32') {
      assert.equal(statSync(output).mode & 0o777, 0o700);
      assert.equal(statSync(join(output, 'config.json')).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('release checks distinguish incomplete source archives from missing local tags', () => {
  const model = validateHandoffConfig(config(), { rootDir: ROOT });
  const archive = mkdtempSync(join(tmpdir(), 'pact-source-archive-'));
  try {
    assert.throws(
      () => verifyReleaseTag(model, { rootDir: archive }),
      /full Git checkout; GitHub source ZIP\/tar archives are unsupported/,
    );
  } finally {
    rmSync(archive, { recursive: true, force: true });
  }

  const missing = structuredClone(model);
  missing.release.sourceRef = 'v999.999.999';
  assert.throws(
    () => verifyReleaseTag(missing, { rootDir: ROOT }),
    /git fetch --tags --force/,
  );
});

test('handoff preparation rejects symbolic-link output ancestors', { skip: process.platform === 'win32' }, () => {
  const parent = join(ROOT, '.contract-handoff', `handoff-symlink-${process.pid}-${Date.now()}`);
  const outside = mkdtempSync(join(tmpdir(), 'handoff-output-escape-'));
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(parent, 'config.json'), `${JSON.stringify(config())}\n`);
  symlinkSync(outside, join(parent, 'linked'), 'dir');
  try {
    assert.throws(
      () => prepareHandoff({
        rootDir: ROOT,
        configPath: relative(ROOT, join(parent, 'config.json')),
        outDir: relative(ROOT, join(parent, 'linked', 'output')),
      }),
      /symbolic-link ancestor/,
    );
    assert.equal(existsSync(join(outside, 'output')), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('default handoff output writes a customer-scoped pipeline and Input Set in a fresh checkout', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'handoff-default-output-'));
  const checkout = join(temporary, 'repo');
  try {
    const clone = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', ROOT, checkout], { encoding: 'utf8' });
    assert.equal(clone.status, 0, clone.stderr || clone.stdout);
    mkdirSync(join(checkout, '.contract-handoff'), { recursive: true });
    writeFileSync(join(checkout, '.contract-handoff/config.json'), `${JSON.stringify(config())}\n`);
    const result = prepareHandoff({ rootDir: checkout });
    assert.equal(existsSync(join(checkout, result.relativePipeline)), true);
    assert.equal(existsSync(join(checkout, result.relativeInputSet)), true);
    const pipeline = YAML.parse(readFileSync(join(checkout, result.relativePipeline), 'utf8')).pipeline;
    assert.equal(pipeline.orgIdentifier, 'default');
    assert.equal(pipeline.projectIdentifier, 'default_project');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('handoff renderer fails closed on placeholders, moved tags, and unsafe customer bindings', () => {
  const placeholder = config();
  placeholder.infrastructure.kubernetesConnector = 'REPLACE_WITH_KUBERNETES_CONNECTOR';
  assert.throws(() => validateHandoffConfig(placeholder, { rootDir: ROOT }), /REPLACE placeholder/);

  const badUrl = config();
  badUrl.broker.baseUrl = 'http://broker.example.test';
  assert.throws(() => validateHandoffConfig(badUrl, { rootDir: ROOT }), /HTTPS URL/);

  const temporaryTunnel = config();
  temporaryTunnel.broker.baseUrl = 'https://customer-demo.trycloudflare.com';
  assert.throws(() => validateHandoffConfig(temporaryTunnel, { rootDir: ROOT }), /temporary tunnel URLs/);

  const credential = config();
  const unsafeBinding = JSON.parse(readFileSync(join(ROOT, credential.postman.bindingFile), 'utf8'));
  unsafeBinding.apiKey = 'not-even-a-real-key';
  credential.postman = { binding: unsafeBinding };
  assert.throws(() => validateHandoffConfig(credential, { rootDir: ROOT }), /forbidden credential field/);

  const moved = validateHandoffConfig(config(), { rootDir: ROOT });
  moved.release.reviewedSourceCommit = '0'.repeat(40);
  assert.throws(() => verifyReleaseTag(moved, { rootDir: ROOT }), /resolves to/);
});
