import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  PIPELINE_VARIABLES,
  SECRET_IDENTIFIERS,
  prepareHandoff,
  renderHarnessInputSet,
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
      sourceRef: 'v0.6.0',
      reviewedSourceCommit: '5c78b1e9aaa6da92db3c0683b71849a639155f21',
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
  assert.equal(inputSet.pipeline.properties.ci.codebase.build.spec.tag, 'v0.6.0');
  assert.equal(values.CONSUMER_WORKSPACE_ID, 'd5576940-9307-447d-91df-70b5fbb33e03');
  assert.equal(values.PROVIDER_COLLECTION_UID, '55358385-070f346f-4c4b-4621-8871-908ceb21341d');
  assert.equal(values.REVIEWED_SOURCE_COMMIT, model.release.reviewedSourceCommit);
  assert.doesNotMatch(source, /secrets\.getValue|PMAK-|password|token/i);
  for (const secret of SECRET_IDENTIFIERS) assert.doesNotMatch(source, new RegExp(secret));
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
    assert.equal(readFileSync(join(output, 'README.md'), 'utf8'), 'operator-owned\n');
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('handoff renderer fails closed on placeholders, moved tags, and unsafe customer bindings', () => {
  const placeholder = config();
  placeholder.infrastructure.kubernetesConnector = 'REPLACE_WITH_KUBERNETES_CONNECTOR';
  assert.throws(() => validateHandoffConfig(placeholder, { rootDir: ROOT }), /REPLACE placeholder/);

  const badUrl = config();
  badUrl.broker.baseUrl = 'http://broker.example.test';
  assert.throws(() => validateHandoffConfig(badUrl, { rootDir: ROOT }), /HTTPS URL/);

  const moved = validateHandoffConfig(config(), { rootDir: ROOT });
  moved.release.reviewedSourceCommit = '0'.repeat(40);
  assert.throws(() => verifyReleaseTag(moved, { rootDir: ROOT }), /resolves to/);
});
