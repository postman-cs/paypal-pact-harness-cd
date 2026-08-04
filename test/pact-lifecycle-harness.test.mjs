import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function stage(name) {
  const path = join(ROOT, 'harness', 'stages', name);
  const source = readFileSync(path, 'utf8');
  const document = YAML.parse(source);
  assert.ok(document?.stage?.identifier, `${name} must be an importable Harness stage`);
  return { source, document };
}

test('Postman preflight retrieves both workspace-bound OAS documents with the service account secret', () => {
  const { source } = stage('postman-oas-preflight.yaml');
  for (const flag of [
    '--consumer-workspace-id', '--consumer-spec-id',
    '--provider-workspace-id', '--provider-spec-id',
  ]) assert.match(source, new RegExp(flag));
  assert.match(source, /paypal_postman_service_account_pmak/);
  assert.match(source, /oas-to-pact/);
  assert.match(source, /bdc-verify/);
  assert.match(source, /\.contract-reports\/postman-oas/);
  assert.match(source, /postman-oas-provenance\.json/);
});

test('consumer publication validates strict executable pacts with immutable version and branch metadata', () => {
  const { source, document } = stage('pact-consumer-publish.yaml');
  const steps = document.stage.spec.execution.steps.map((entry) => entry.step.identifier);
  const variables = Object.fromEntries(document.stage.variables.map((variable) => [variable.name, variable]));
  assert.ok(steps.indexOf('generate_executable_consumer_pacts') < steps.indexOf('publish_validated_pacts'));
  assert.match(source, /CONSUMER_CONTRACT_COMMAND/);
  assert.match(source, /consumer-pact-run\.mjs/);
  assert.match(source, /prepare "\$PACTS_PATH"/);
  assert.match(source, /export PACT_OUTPUT_DIR="\$PACTS_PATH"/);
  assert.match(source, /validate "\$PACTS_PATH"/);
  assert.equal(variables.pacts_path.value, '<+input>');
  assert.equal(variables.consumer_branch.value, '<+input>');
  assert.doesNotMatch(source, /fixtures\/paypal\/orders-consumer\.pact\.json/);
  assert.match(source, /pact broker publish/);
  assert.match(source, /--consumer-app-version/);
  assert.match(source, /--branch/);
  assert.match(source, /--validate/);
  assert.match(source, /--strict/);
});

test('provider verification uses broker selectors, pending and WIP pacts, states, and publishes evidence', () => {
  const { source, document } = stage('pact-provider-verify.yaml');
  for (const flag of [
    '--consumer-version-selectors', '--enable-pending', '--include-wip-pacts-since',
    '--state-change-url', '--publish', '--provider-version', '--provider-branch',
    '--junit', '--json',
  ]) assert.match(source, new RegExp(flag));
  assert.doesNotMatch(source, /--ignore-no-pacts-error/);
  assert.match(source, /wait-for-provider\.mjs/);
  const variables = Object.fromEntries(document.stage.variables.map((variable) => [variable.name, variable]));
  assert.equal(variables.provider_readiness_url.value, '<+input>');
  assert.equal(variables.provider_hostname.value, '<+input>');
  assert.equal(variables.provider_port.value, '<+input>');
  assert.equal(variables.provider_transport.value, '<+input>');
  assert.equal(variables.state_change_url.value, '<+input>');
  assert.doesNotMatch(source, /default\(127\.0\.0\.1\)|default\(http:\/\/127\.0\.0\.1/);
});

test('deployment decision and deployment recording remain separate ordered responsibilities', () => {
  const gate = stage('pact-can-i-deploy.yaml').source;
  const record = stage('pact-record-deployment.yaml').source;
  assert.match(gate, /immediately before PayPal's existing deployment/);
  assert.match(gate, /pact broker can-i-deploy/);
  assert.doesNotMatch(gate, /record-deployment/);
  assert.match(record, /only after PayPal's real deployment step has succeeded/);
  assert.match(record, /pact broker record-deployment/);
  assert.doesNotMatch(record, /pact broker can-i-deploy/);
});

test('all official Pact stages use the digest-locked installer and secrets are references only', () => {
  const names = [
    'pact-consumer-publish.yaml',
    'pact-provider-verify.yaml',
    'pact-can-i-deploy.yaml',
    'pact-record-deployment.yaml',
  ];
  for (const name of names) {
    const source = stage(name).source;
    assert.match(source, /install-pact-cli\.mjs/);
    assert.match(source, /pact-cli\.lock\.json/);
    assert.match(source, /paypal_pact_broker_password/);
    assert.match(source, /PACT_BROKER_USERNAME/);
    assert.match(source, /PACT_BROKER_PASSWORD/);
    assert.doesNotMatch(source, /PACT_BROKER_TOKEN/);
    assert.match(source, /PACT_DO_NOT_TRACK: "true"/);
  }

  const harnessSources = readdirSync(join(ROOT, 'harness'), { recursive: true })
    .filter((name) => String(name).endsWith('.yaml'))
    .map((name) => readFileSync(join(ROOT, 'harness', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(harnessSources, /PMAK-[A-Za-z0-9_-]+/);
});

test('the lower Broker proof keeps Postman and static gates before every Broker decision', () => {
  const source = readFileSync(join(ROOT, 'harness', 'contract-gate.broker.pipeline.yaml'), 'utf8');
  const pipeline = YAML.parse(source).pipeline;
  const variables = Object.fromEntries(pipeline.variables.map((variable) => [variable.name, variable]));
  assert.equal(pipeline.stages[0].stage.name, 'Consumer first Broker');
  const postman = source.indexOf('identifier: postman_static_preflight');
  const existing = source.indexOf('identifier: existing_postman_provider_gate');
  const publish = source.indexOf('identifier: publish_seeded_consumer_pact');
  const verify = source.indexOf('identifier: official_provider_verification');
  const deploy = source.indexOf('identifier: broker_can_i_deploy_lower');
  assert.ok(postman >= 0 && postman < existing && existing < publish && publish < verify && verify < deploy);
  assert.doesNotMatch(source, /pact broker record-deployment/);
  assert.ok((source.match(/paypal_contract_demo_token/g) ?? []).length >= 3,
    'the lower provider, static gate, and official verifier must share the demo credential');
  assert.doesNotMatch(source, /paypal_pact_provider_bearer_token/);
  assert.match(source, /production consumer\r?\n# repositories must publish pacts created by executable tests/);
  assert.equal(variables.REVIEWED_SOURCE_COMMIT.value, '<+input>');
  assert.equal(variables.CONSUMER_PACT_BRANCH.value, '<+input>');
  assert.equal(variables.PROVIDER_PACT_BRANCH.value, '<+input>');
  assert.match(source, /EXPECTED_SOURCE_COMMIT: <\+pipeline\.variables\.REVIEWED_SOURCE_COMMIT>/);
  assert.match(source, /CONSUMER_APP_VERSION: <\+pipeline\.variables\.REVIEWED_SOURCE_COMMIT>/);
  assert.match(source, /PROVIDER_VERSION: <\+pipeline\.variables\.REVIEWED_SOURCE_COMMIT>/);
  assert.match(source, /CONSUMER_PACT_BRANCH: <\+pipeline\.variables\.CONSUMER_PACT_BRANCH>/);
  assert.match(source, /PROVIDER_PACT_BRANCH: <\+pipeline\.variables\.PROVIDER_PACT_BRANCH>/);
  assert.match(source, /broker publish[\s\S]{0,500}--retries 0[\s\S]{0,100}--log-level error/,
    'the diagnostic Broker proof must surface the first publication error without exponential backoff');
  assert.equal((source.match(/SSL_CERT_FILE: \/etc\/ssl\/certs\/ca-certificates\.crt/g) ?? []).length, 3,
    'every Pact CLI Broker step must explicitly use the Debian CA bundle');
  assert.equal((source.match(/test -r "\$SSL_CERT_FILE"/g) ?? []).length, 3,
    'every Pact CLI Broker step must fail closed when its CA bundle is unavailable');
  assert.doesNotMatch(source, /<\+codebase\.branch>/,
    'branch, tag, PR, and manual runs must use explicit logical Pact branch inputs');
});
