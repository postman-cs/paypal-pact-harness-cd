#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PIPELINE_IDENTIFIER = 'paypal_postman_pact_broker_lower';
const SECRET_IDENTIFIERS = [
  'paypal_postman_service_account_pmak',
  'paypal_pact_broker_password',
  'paypal_contract_demo_token',
];
const PIPELINE_VARIABLES = [
  'CONTAINER_REGISTRY_CONNECTOR',
  'KUBERNETES_CONNECTOR',
  'KUBERNETES_NAMESPACE',
  'BROKER_BASE_URL',
  'REVIEWED_SOURCE_COMMIT',
  'CONSUMER_PACT_BRANCH',
  'PROVIDER_PACT_BRANCH',
  'CONSUMER_WORKSPACE_ID',
  'CONSUMER_SPEC_ID',
  'CONSUMER_SPEC_CANONICAL_SHA256',
  'PROVIDER_WORKSPACE_ID',
  'PROVIDER_SPEC_ID',
  'PROVIDER_SPEC_CANONICAL_SHA256',
  'PROVIDER_COLLECTION_UID',
  'PROVIDER_COLLECTION_WORKSPACE_ID',
  'PROVIDER_COLLECTION_CANONICAL_SHA256',
  'INCLUDE_WIP_PACTS_SINCE',
  'TARGET_ENVIRONMENT',
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function onlyKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.sort().join(', ')}`);
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const result = value.trim();
  if (/^REPLACE(?:_|$)/i.test(result)) throw new Error(`${label} still contains a REPLACE placeholder`);
  if (/[\0\r\n]/.test(result)) throw new Error(`${label} contains a forbidden control character`);
  return result;
}

function harnessIdentifier(value, label) {
  const result = text(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(result)) {
    throw new Error(`${label} is not a valid Harness identifier`);
  }
  return result;
}

function connectorRef(value, label) {
  const result = text(value, label);
  if (!/^(?:(?:account|org|project)\.)?[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(result)) {
    throw new Error(`${label} is not a valid Harness connector reference`);
  }
  return result;
}

function releaseTag(value) {
  const result = text(value, 'release.sourceRef');
  if (!/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(result)) {
    throw new Error('release.sourceRef must be an immutable semantic release tag such as v0.5.0');
  }
  return result;
}

function commit(value) {
  const result = text(value, 'release.reviewedSourceCommit');
  if (!/^[a-f0-9]{40}$/.test(result)) throw new Error('release.reviewedSourceCommit must be a full Git SHA');
  return result;
}

function pactBranch(value, label) {
  const result = text(value, label);
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(result) || result.startsWith('/') || result.endsWith('/') || result.includes('..')) {
    throw new Error(`${label} is not a safe logical Pact branch`);
  }
  return result;
}

function kubernetesNamespace(value) {
  const result = text(value, 'infrastructure.kubernetesNamespace');
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(result)) {
    throw new Error('infrastructure.kubernetesNamespace must be a DNS-compatible Kubernetes namespace');
  }
  return result;
}

function httpsUrl(value) {
  const result = text(value, 'broker.baseUrl');
  let url;
  try {
    url = new URL(result);
  } catch {
    throw new Error('broker.baseUrl must be an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('broker.baseUrl must be an HTTPS URL without credentials, query, or fragment');
  }
  return url.toString().replace(/\/$/, '');
}

function isoDate(value) {
  const result = text(value, 'broker.includeWipPactsSince');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw new Error('broker.includeWipPactsSince must be an ISO date (YYYY-MM-DD)');
  }
  return result;
}

function assetId(value, label) {
  const result = text(value, label);
  if (!/^[A-Za-z0-9_-]{3,200}$/.test(result)) throw new Error(`${label} contains invalid characters`);
  return result;
}

function canonicalDigest(value, label) {
  const result = text(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} must be a canonical SHA-256`);
  return result;
}

function confinedFile(rootDir, input, label) {
  const value = text(input, label);
  if (isAbsolute(value)) throw new Error(`${label} must be repository-relative`);
  const target = resolve(rootDir, value);
  const rel = relative(rootDir, target);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${label} must resolve inside the repository`);
  }
  if (!existsSync(target)) throw new Error(`${label} does not exist: ${value}`);
  const realRel = relative(realpathSync(rootDir), realpathSync(target));
  if (realRel === '..' || realRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realRel)) {
    throw new Error(`${label} resolves outside the repository`);
  }
  return target;
}

function approvedSpecDigest(spec, label) {
  const source = spec.sourceCanonicalSha256 ?? spec.canonicalSha256;
  const digest = canonicalDigest(source, `${label}.sourceCanonicalSha256`);
  if (spec.canonicalSha256 && canonicalDigest(spec.canonicalSha256, `${label}.canonicalSha256`) !== digest) {
    throw new Error(`${label} source and live canonical digests disagree`);
  }
  return digest;
}

export function validateHandoffConfig(raw, { rootDir = ROOT } = {}) {
  const config = record(raw, 'handoff config');
  onlyKeys(config, ['schemaVersion', 'harness', 'release', 'infrastructure', 'broker', 'postman'], 'handoff config');
  if (config.schemaVersion !== 1) throw new Error('handoff config schemaVersion must be 1');
  const harness = record(config.harness, 'harness');
  const release = record(config.release, 'release');
  const infrastructure = record(config.infrastructure, 'infrastructure');
  const broker = record(config.broker, 'broker');
  const postman = record(config.postman, 'postman');
  onlyKeys(harness, ['orgIdentifier', 'projectIdentifier', 'inputSetName', 'inputSetIdentifier'], 'harness');
  onlyKeys(release, ['sourceRef', 'reviewedSourceCommit', 'consumerPactBranch', 'providerPactBranch'], 'release');
  onlyKeys(infrastructure, [
    'codebaseConnector',
    'containerRegistryConnector',
    'kubernetesConnector',
    'kubernetesNamespace',
  ], 'infrastructure');
  onlyKeys(broker, ['baseUrl', 'includeWipPactsSince', 'targetEnvironment'], 'broker');
  onlyKeys(postman, ['bindingFile'], 'postman');

  const bindingPath = confinedFile(rootDir, postman.bindingFile, 'postman.bindingFile');
  const binding = record(JSON.parse(readFileSync(bindingPath, 'utf8')), 'Postman binding file');
  const consumer = record(binding.consumer, 'Postman consumer binding');
  const provider = record(binding.provider, 'Postman provider binding');
  const targetEnvironment = text(broker.targetEnvironment, 'broker.targetEnvironment');
  if (targetEnvironment !== 'lower') throw new Error('the supplied Broker proof is locked to targetEnvironment=lower');

  const values = {
    CONTAINER_REGISTRY_CONNECTOR: connectorRef(
      infrastructure.containerRegistryConnector,
      'infrastructure.containerRegistryConnector',
    ),
    KUBERNETES_CONNECTOR: connectorRef(infrastructure.kubernetesConnector, 'infrastructure.kubernetesConnector'),
    KUBERNETES_NAMESPACE: kubernetesNamespace(infrastructure.kubernetesNamespace),
    BROKER_BASE_URL: httpsUrl(broker.baseUrl),
    REVIEWED_SOURCE_COMMIT: commit(release.reviewedSourceCommit),
    CONSUMER_PACT_BRANCH: pactBranch(release.consumerPactBranch, 'release.consumerPactBranch'),
    PROVIDER_PACT_BRANCH: pactBranch(release.providerPactBranch, 'release.providerPactBranch'),
    CONSUMER_WORKSPACE_ID: assetId(consumer.workspace?.id, 'consumer.workspace.id'),
    CONSUMER_SPEC_ID: assetId(consumer.spec?.id, 'consumer.spec.id'),
    CONSUMER_SPEC_CANONICAL_SHA256: approvedSpecDigest(consumer.spec ?? {}, 'consumer.spec'),
    PROVIDER_WORKSPACE_ID: assetId(provider.workspace?.id, 'provider.workspace.id'),
    PROVIDER_SPEC_ID: assetId(provider.spec?.id, 'provider.spec.id'),
    PROVIDER_SPEC_CANONICAL_SHA256: approvedSpecDigest(provider.spec ?? {}, 'provider.spec'),
    PROVIDER_COLLECTION_UID: assetId(provider.collection?.uid, 'provider.collection.uid'),
    PROVIDER_COLLECTION_WORKSPACE_ID: assetId(provider.workspace?.id, 'provider.workspace.id'),
    PROVIDER_COLLECTION_CANONICAL_SHA256: canonicalDigest(
      provider.collection?.canonicalSha256,
      'provider.collection.canonicalSha256',
    ),
    INCLUDE_WIP_PACTS_SINCE: isoDate(broker.includeWipPactsSince),
    TARGET_ENVIRONMENT: targetEnvironment,
  };
  if (Object.keys(values).length !== PIPELINE_VARIABLES.length || PIPELINE_VARIABLES.some((name) => !values[name])) {
    throw new Error('handoff config does not cover every Broker pipeline variable');
  }

  return {
    harness: {
      orgIdentifier: harnessIdentifier(harness.orgIdentifier, 'harness.orgIdentifier'),
      projectIdentifier: harnessIdentifier(harness.projectIdentifier, 'harness.projectIdentifier'),
      inputSetName: text(harness.inputSetName, 'harness.inputSetName'),
      inputSetIdentifier: harnessIdentifier(harness.inputSetIdentifier, 'harness.inputSetIdentifier'),
      pipelineIdentifier: PIPELINE_IDENTIFIER,
    },
    release: {
      sourceRef: releaseTag(release.sourceRef),
      reviewedSourceCommit: values.REVIEWED_SOURCE_COMMIT,
    },
    codebaseConnector: connectorRef(infrastructure.codebaseConnector, 'infrastructure.codebaseConnector'),
    bindingFile: relative(rootDir, bindingPath).replaceAll('\\', '/'),
    values,
  };
}

function yaml(value) {
  return JSON.stringify(String(value));
}

export function renderHarnessInputSet(model) {
  const lines = [
    '# Generated by scripts/tpe/prepare-handoff.mjs. Contains no credentials.',
    'inputSet:',
    `  name: ${yaml(model.harness.inputSetName)}`,
    `  identifier: ${yaml(model.harness.inputSetIdentifier)}`,
    `  orgIdentifier: ${yaml(model.harness.orgIdentifier)}`,
    `  projectIdentifier: ${yaml(model.harness.projectIdentifier)}`,
    '  tags: {}',
    '  pipeline:',
    `    identifier: ${yaml(model.harness.pipelineIdentifier)}`,
    '    properties:',
    '      ci:',
    '        codebase:',
    `          connectorRef: ${yaml(model.codebaseConnector)}`,
    '          build:',
    '            type: tag',
    '            spec:',
    `              tag: ${yaml(model.release.sourceRef)}`,
    '    variables:',
  ];
  for (const name of PIPELINE_VARIABLES) {
    lines.push(
      `      - name: ${name}`,
      '        type: String',
      `        value: ${yaml(model.values[name])}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function verifyReleaseTag(model, { rootDir = ROOT } = {}) {
  const target = `refs/tags/${model.release.sourceRef}^{commit}`;
  const result = spawnSync('git', ['rev-parse', '--verify', target], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`release tag ${model.release.sourceRef} is not available locally`);
  const actual = result.stdout.trim();
  if (actual !== model.release.reviewedSourceCommit) {
    throw new Error(
      `release tag ${model.release.sourceRef} resolves to ${actual}, expected ${model.release.reviewedSourceCommit}`,
    );
  }
  return actual;
}

function dedicatedOutput(rootDir, input) {
  const value = text(input, 'outDir');
  if (isAbsolute(value)) throw new Error('outDir must be repository-relative');
  const base = resolve(rootDir, '.contract-handoff');
  const target = resolve(rootDir, value);
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('outDir must stay under .contract-handoff');
  }
  mkdirSync(target, { recursive: true });
  const realRel = relative(realpathSync(rootDir), realpathSync(target));
  if (realRel === '..' || realRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realRel)) {
    throw new Error('outDir resolves outside the repository');
  }
  return target;
}

function atomicWrite(path, content, { force }) {
  if (existsSync(path) && !force) throw new Error(`${relative(ROOT, path)} already exists; pass --force to replace it`);
  const temporary = `${path}.part-${process.pid}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function checklist(model, inputSetPath) {
  return `# PayPal Pact Harness handoff\n\n` +
    `Generated from ${model.bindingFile}. No credentials are stored here.\n\n` +
    `1. Import \`harness/contract-gate.broker.pipeline.yaml\` into Harness project ` +
    `\`${model.harness.orgIdentifier}/${model.harness.projectIdentifier}\`.\n` +
    `2. Import \`${inputSetPath}\` as an Input Set for ` +
    `\`${model.harness.pipelineIdentifier}\`.\n` +
    `3. Confirm these project secrets exist: ${SECRET_IDENTIFIERS.map((name) => `\`${name}\``).join(', ')}.\n` +
    `4. Run the pipeline with release \`${model.release.sourceRef}\`; source attestation must report ` +
    `\`${model.release.reviewedSourceCommit}\`.\n` +
    '5. Require Postman/OAS, provider verification, and a non-empty `can-i-deploy` decision before promotion.\n\n' +
    'The supplied integration proof does not deploy or record a deployment. Real service pipelines must run ' +
    '`pact-record-deployment` only after deployment and target-environment Postman smoke tests succeed.\n';
}

export function prepareHandoff({
  rootDir = ROOT,
  configPath = '.contract-handoff/config.json',
  outDir = '.contract-handoff',
  force = false,
  check = false,
} = {}) {
  const configFile = confinedFile(rootDir, configPath, 'config');
  const model = validateHandoffConfig(JSON.parse(readFileSync(configFile, 'utf8')), { rootDir });
  verifyReleaseTag(model, { rootDir });
  const rendered = renderHarnessInputSet(model);
  const inputSetName = `${model.harness.inputSetIdentifier}.input-set.yaml`;
  const relativeInputSet = join(outDir, inputSetName).replaceAll('\\', '/');
  if (!check) {
    const output = dedicatedOutput(rootDir, outDir);
    const inputSetPath = join(output, inputSetName);
    const targets = [inputSetPath, join(output, 'handoff-manifest.json'), join(output, 'README.md')];
    if (!force) {
      const existing = targets.find((target) => existsSync(target));
      if (existing) throw new Error(`${relative(rootDir, existing)} already exists; pass --force to replace the handoff`);
    }
    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      classification: 'secret-free Harness handoff',
      pipelineIdentifier: model.harness.pipelineIdentifier,
      release: model.release,
      postmanBindingFile: model.bindingFile,
      pipelineVariables: PIPELINE_VARIABLES,
      requiredHarnessSecrets: SECRET_IDENTIFIERS,
      inputSet: {
        path: relativeInputSet,
        sha256: sha256(rendered),
      },
    };
    atomicWrite(inputSetPath, rendered, { force });
    atomicWrite(join(output, 'handoff-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { force });
    atomicWrite(join(output, 'README.md'), checklist(model, relativeInputSet), { force });
  }
  console.log(`[ok] release ${model.release.sourceRef} -> ${model.release.reviewedSourceCommit}`);
  console.log(`[ok] Postman binding ${model.bindingFile}`);
  console.log(`[ok] Harness runtime coverage ${PIPELINE_VARIABLES.length}/${PIPELINE_VARIABLES.length}`);
  console.log(check ? '[ready] handoff configuration is valid' : `[ready] import ${relativeInputSet}`);
  return { model, rendered, relativeInputSet };
}

function parseArgs(argv) {
  const result = {
    configPath: '.contract-handoff/config.json',
    outDir: '.contract-handoff',
    force: false,
    check: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--config' || value === '--out-dir') {
      const next = argv[++index];
      if (!next || next.startsWith('-')) throw new Error(`${value} requires a repository-relative path`);
      if (value === '--config') result.configPath = next;
      else result.outDir = next;
    } else if (value === '--force') result.force = true;
    else if (value === '--check') result.check = true;
    else if (value === '--help' || value === '-h') result.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function help() {
  console.log(`Prepare a secret-free PayPal Pact Harness handoff\n\n` +
    `Usage:\n` +
    `  node scripts/tpe/prepare-handoff.mjs --config .contract-handoff/config.json [--out-dir .contract-handoff]\n` +
    `  node scripts/tpe/prepare-handoff.mjs --config .contract-handoff/config.json --check\n\n` +
    `Copy config/paypal-tpe-handoff.example.json into .contract-handoff/config.json,\n` +
    `replace the customer-owned connector and Broker placeholders, then run this command.\n` +
    `The generated Harness Input Set contains no secrets.\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) help();
    else prepareHandoff(args);
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    console.error('Next: copy config/paypal-tpe-handoff.example.json to .contract-handoff/config.json and replace every REPLACE placeholder.');
    process.exitCode = 2;
  }
}

export { PIPELINE_VARIABLES, SECRET_IDENTIFIERS };
