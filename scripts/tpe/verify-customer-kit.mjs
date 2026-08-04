#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(ROOT, 'KIT-MANIFEST.json');
const EXPECTED_VARIABLES = [
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
const CUSTOMER_TOOLKIT_ROOT_FILES = new Set([
  'toolkit/README.md',
  'toolkit/package.json',
  'toolkit/postman-cs.lock.json',
  'toolkit/paypal-contract-gate.mjs',
  'toolkit/contract-gate.mjs',
  'toolkit/pact-harness.mjs',
  'toolkit/src/bdc-verify.mjs',
  'toolkit/src/cli.mjs',
  'toolkit/src/contract-topology.mjs',
  'toolkit/src/ledger-store.mjs',
  'toolkit/src/lib/git-retry.mjs',
  'toolkit/src/lib/ledger.mjs',
  'toolkit/src/lib/load.mjs',
  'toolkit/src/lib/oas.mjs',
  'toolkit/src/lib/pact.mjs',
  'toolkit/src/lib/path-safety.mjs',
  'toolkit/src/lib/schema-validate.mjs',
  'toolkit/src/lib/subset.mjs',
  'toolkit/src/oas-audit.mjs',
  'toolkit/src/oas-diff.mjs',
  'toolkit/src/oas-to-pact.mjs',
  'toolkit/src/postman-to-pact.mjs',
  'toolkit/src/provider-verify.mjs',
  'toolkit/src/route-exceptions.mjs',
  'toolkit/src/tpe-cli.mjs',
  'toolkit/src/tpe-config.mjs',
  'toolkit/vendor/postman-cs/PROVENANCE.json',
  'toolkit/vendor/postman-cs/compare-routes.mjs',
]);

function allowedToolkitPath(path) {
  return CUSTOMER_TOOLKIT_ROOT_FILES.has(path) || path.startsWith('toolkit/vendor/yaml/');
}

function fail(message) {
  throw new Error(message);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function safeRelative(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) {
    fail(`unsafe manifest path: ${String(path)}`);
  }
  return path;
}

function walk(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`symbolic links are not allowed in the kit: ${name}`);
    if (name === 'KIT-MANIFEST.json') continue;
    if (entry.isDirectory()) files.push(...walk(absolute, name));
    else if (entry.isFile()) files.push(name);
    else fail(`unsupported filesystem entry in kit: ${name}`);
  }
  return files.sort();
}

function parseInputSet(source) {
  const values = new Map();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*- name: ([A-Z0-9_]+)$/);
    if (!match) continue;
    const value = lines[index + 2]?.match(/^\s*value: (.+)$/)?.[1];
    if (!value) fail(`Harness Input Set has no value for ${match[1]}`);
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      fail(`Harness Input Set value for ${match[1]} is not a quoted scalar`);
    }
    values.set(match[1], parsed);
  }
  return values;
}

function quotedScalar(source, pattern, label) {
  const raw = source.match(pattern)?.[1];
  if (!raw) fail(`${label} is missing`);
  try {
    return JSON.parse(raw);
  } catch {
    return raw.replace(/^['"]|['"]$/g, '');
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function normalizedBrokerUrl(value) {
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    fail('handoff config Broker URL is invalid');
  }
}

function validateChecksumInventory(source, manifest) {
  const checksumEntries = new Map();
  for (const line of source.trimEnd().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})  ([^\\].*)$/);
    if (!match) fail('SHA256SUMS contains a malformed line');
    const path = safeRelative(match[2]);
    if (checksumEntries.has(path)) fail(`SHA256SUMS contains duplicate path: ${path}`);
    checksumEntries.set(path, match[1]);
  }
  const expected = manifest.files.filter((entry) => entry.path !== 'SHA256SUMS');
  if (checksumEntries.size !== expected.length) fail('SHA256SUMS file count differs from the manifest');
  for (const entry of expected) {
    if (checksumEntries.get(entry.path) !== entry.sha256) fail(`SHA256SUMS contradicts the manifest: ${entry.path}`);
  }
}

function validatePostmanBinding(binding) {
  const required = [
    ['consumer.workspace.id', binding.consumer?.workspace?.id, /^[A-Za-z0-9_-]{3,200}$/],
    ['consumer.spec.id', binding.consumer?.spec?.id, /^[A-Za-z0-9_-]{3,200}$/],
    ['consumer.spec digest', binding.consumer?.spec?.sourceCanonicalSha256 ?? binding.consumer?.spec?.canonicalSha256, /^[a-f0-9]{64}$/],
    ['provider.workspace.id', binding.provider?.workspace?.id, /^[A-Za-z0-9_-]{3,200}$/],
    ['provider.spec.id', binding.provider?.spec?.id, /^[A-Za-z0-9_-]{3,200}$/],
    ['provider.spec digest', binding.provider?.spec?.sourceCanonicalSha256 ?? binding.provider?.spec?.canonicalSha256, /^[a-f0-9]{64}$/],
    ['provider.collection.uid', binding.provider?.collection?.uid, /^[A-Za-z0-9_-]{3,200}$/],
    ['provider.collection digest', binding.provider?.collection?.canonicalSha256, /^[a-f0-9]{64}$/],
  ];
  for (const [label, value, pattern] of required) {
    if (typeof value !== 'string' || !pattern.test(value) || /^REPLACE(?:_|$)/i.test(value)) {
      fail(`Postman binding is incomplete: ${label}`);
    }
  }
}

function rejectCredentialFields(value, label) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:password|passphrase|token|secret|api.?key|authorization|credential)/i.test(key)) {
      fail(`${label} contains forbidden credential field: ${key}`);
    }
    rejectCredentialFields(child, label);
  }
}

function main() {
  if (!existsSync(MANIFEST_PATH)) fail('KIT-MANIFEST.json is missing');
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.classification !== 'customer-confidential operational metadata') {
    fail('kit manifest identity or classification is invalid');
  }
  if (!/^v\d+\.\d+\.\d+/.test(manifest.release?.sourceRef ?? '') ||
      !/^[a-f0-9]{40}$/.test(manifest.release?.reviewedSourceCommit ?? '')) {
    fail('kit manifest release attestation is invalid');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('kit manifest has no file inventory');

  const expected = new Set();
  for (const entry of manifest.files) {
    const name = safeRelative(entry.path);
    if (expected.has(name)) fail(`duplicate manifest path: ${name}`);
    expected.add(name);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      fail(`invalid manifest entry: ${name}`);
    }
    const target = resolve(ROOT, name);
    if (relative(ROOT, target).startsWith('..') || !existsSync(target) || !lstatSync(target).isFile()) {
      fail(`missing kit file: ${name}`);
    }
    const content = readFileSync(target);
    if (content.length !== entry.bytes) fail(`byte count mismatch: ${name}`);
    if (sha256(content) !== entry.sha256) fail(`SHA-256 mismatch: ${name}`);
  }

  const actual = walk(ROOT);
  const extras = actual.filter((name) => !expected.has(name));
  const missing = [...expected].filter((name) => !actual.includes(name));
  if (extras.length || missing.length) {
    fail(`kit inventory mismatch; extra=[${extras.join(', ')}] missing=[${missing.join(', ')}]`);
  }
  validateChecksumInventory(readFileSync(join(ROOT, 'SHA256SUMS'), 'utf8'), manifest);

  const inputSet = readFileSync(join(ROOT, 'demo', 'harness-input-set.yaml'), 'utf8');
  const values = parseInputSet(inputSet);
  if (values.size !== EXPECTED_VARIABLES.length || EXPECTED_VARIABLES.some((name) => !values.has(name))) {
    fail(`Harness runtime coverage is ${values.size}/${EXPECTED_VARIABLES.length}`);
  }
  if (values.get('REVIEWED_SOURCE_COMMIT') !== manifest.release.reviewedSourceCommit) {
    fail('Input Set reviewed commit differs from the kit release attestation');
  }
  if (inputSet.includes('REPLACE_')) fail('Harness Input Set still contains a placeholder');

  const pipeline = readFileSync(join(ROOT, 'demo', 'harness-pipeline.yaml'), 'utf8');
  const provenance = JSON.parse(readFileSync(join(ROOT, 'provenance', 'release.json'), 'utf8'));
  const pipelineId = pipeline.match(/^\s*identifier:\s*([^\s]+)\s*$/m)?.[1]?.replaceAll('"', '');
  const inputPipelineId = inputSet.match(/^\s{4}identifier:\s*([^\s]+)\s*$/m)?.[1]?.replaceAll('"', '');
  if (!pipelineId || pipelineId !== manifest.pipelineIdentifier || inputPipelineId !== manifest.pipelineIdentifier) {
    fail('pipeline and Input Set identifiers do not match the manifest');
  }
  const pipelineOrg = quotedScalar(pipeline, /^  orgIdentifier:\s*(.+)$/m, 'pipeline orgIdentifier');
  const pipelineProject = quotedScalar(pipeline, /^  projectIdentifier:\s*(.+)$/m, 'pipeline projectIdentifier');
  const inputOrg = quotedScalar(inputSet, /^  orgIdentifier:\s*(.+)$/m, 'Input Set orgIdentifier');
  const inputProject = quotedScalar(inputSet, /^  projectIdentifier:\s*(.+)$/m, 'Input Set projectIdentifier');
  if (pipelineOrg !== manifest.harness?.orgIdentifier || inputOrg !== manifest.harness?.orgIdentifier ||
      pipelineProject !== manifest.harness?.projectIdentifier || inputProject !== manifest.harness?.projectIdentifier) {
    fail('pipeline, Input Set, and manifest Harness org/project scope disagree');
  }
  const inputTag = quotedScalar(inputSet, /^\s+tag:\s*(.+)$/m, 'Input Set release tag');
  if (inputTag !== manifest.release.sourceRef || provenance.runtimeRelease?.sourceRef !== manifest.release.sourceRef ||
      provenance.runtimeRelease?.reviewedSourceCommit !== manifest.release.reviewedSourceCommit) {
    fail('Input Set, provenance, and manifest release attestations disagree');
  }

  const binding = JSON.parse(readFileSync(join(ROOT, 'demo', 'postman-bindings.json'), 'utf8'));
  const handoffConfigSource = readFileSync(join(ROOT, 'provenance', 'customer-handoff-config.json'), 'utf8');
  const handoffConfig = JSON.parse(handoffConfigSource);
  rejectCredentialFields(binding, 'Postman binding');
  rejectCredentialFields(handoffConfig, 'handoff config');
  validatePostmanBinding(binding);
  if (sha256(handoffConfigSource) !== manifest.handoffConfigSha256 ||
      sha256(`${JSON.stringify(binding)}\n`) !== manifest.postmanBindingSha256) {
    fail('handoff configuration or Postman binding digest disagrees with the manifest');
  }
  if (handoffConfig.schemaVersion !== 1 || !sameJson(handoffConfig.postman?.binding, binding)) {
    fail('resolved handoff configuration and Postman binding disagree');
  }

  const inputSetName = quotedScalar(inputSet, /^  name:\s*(.+)$/m, 'Input Set name');
  const inputSetIdentifier = quotedScalar(inputSet, /^  identifier:\s*(.+)$/m, 'Input Set identifier');
  const codebaseConnector = quotedScalar(inputSet, /^          connectorRef:\s*(.+)$/m, 'Input Set codebase connector');
  const configExpected = {
    CONTAINER_REGISTRY_CONNECTOR: handoffConfig.infrastructure?.containerRegistryConnector,
    KUBERNETES_CONNECTOR: handoffConfig.infrastructure?.kubernetesConnector,
    KUBERNETES_NAMESPACE: handoffConfig.infrastructure?.kubernetesNamespace,
    BROKER_BASE_URL: normalizedBrokerUrl(handoffConfig.broker?.baseUrl),
    REVIEWED_SOURCE_COMMIT: handoffConfig.release?.reviewedSourceCommit,
    CONSUMER_PACT_BRANCH: handoffConfig.release?.consumerPactBranch,
    PROVIDER_PACT_BRANCH: handoffConfig.release?.providerPactBranch,
    CONSUMER_WORKSPACE_ID: handoffConfig.postman?.binding?.consumer?.workspace?.id,
    CONSUMER_SPEC_ID: handoffConfig.postman?.binding?.consumer?.spec?.id,
    CONSUMER_SPEC_CANONICAL_SHA256: handoffConfig.postman?.binding?.consumer?.spec?.sourceCanonicalSha256 ??
      handoffConfig.postman?.binding?.consumer?.spec?.canonicalSha256,
    PROVIDER_WORKSPACE_ID: handoffConfig.postman?.binding?.provider?.workspace?.id,
    PROVIDER_SPEC_ID: handoffConfig.postman?.binding?.provider?.spec?.id,
    PROVIDER_SPEC_CANONICAL_SHA256: handoffConfig.postman?.binding?.provider?.spec?.sourceCanonicalSha256 ??
      handoffConfig.postman?.binding?.provider?.spec?.canonicalSha256,
    PROVIDER_COLLECTION_UID: handoffConfig.postman?.binding?.provider?.collection?.uid,
    PROVIDER_COLLECTION_WORKSPACE_ID: handoffConfig.postman?.binding?.provider?.workspace?.id,
    PROVIDER_COLLECTION_CANONICAL_SHA256: handoffConfig.postman?.binding?.provider?.collection?.canonicalSha256,
    INCLUDE_WIP_PACTS_SINCE: handoffConfig.broker?.includeWipPactsSince,
    TARGET_ENVIRONMENT: handoffConfig.broker?.targetEnvironment,
  };
  if (inputSetName !== handoffConfig.harness?.inputSetName ||
      inputSetIdentifier !== handoffConfig.harness?.inputSetIdentifier ||
      codebaseConnector !== handoffConfig.infrastructure?.codebaseConnector ||
      pipelineOrg !== handoffConfig.harness?.orgIdentifier ||
      inputOrg !== handoffConfig.harness?.orgIdentifier ||
      pipelineProject !== handoffConfig.harness?.projectIdentifier ||
      inputProject !== handoffConfig.harness?.projectIdentifier ||
      inputTag !== handoffConfig.release?.sourceRef ||
      manifest.release.sourceRef !== handoffConfig.release?.sourceRef ||
      manifest.release.reviewedSourceCommit !== handoffConfig.release?.reviewedSourceCommit) {
    fail('resolved handoff configuration disagrees with generated Harness identity or release');
  }
  for (const name of EXPECTED_VARIABLES) {
    if (values.get(name) !== configExpected[name]) {
      fail(`resolved handoff configuration and Harness Input Set disagree: ${name}`);
    }
  }
  const bindingValues = {
    CONSUMER_WORKSPACE_ID: binding.consumer.workspace.id,
    CONSUMER_SPEC_ID: binding.consumer.spec.id,
    CONSUMER_SPEC_CANONICAL_SHA256: binding.consumer.spec.sourceCanonicalSha256 ?? binding.consumer.spec.canonicalSha256,
    PROVIDER_WORKSPACE_ID: binding.provider.workspace.id,
    PROVIDER_SPEC_ID: binding.provider.spec.id,
    PROVIDER_SPEC_CANONICAL_SHA256: binding.provider.spec.sourceCanonicalSha256 ?? binding.provider.spec.canonicalSha256,
    PROVIDER_COLLECTION_UID: binding.provider.collection.uid,
    PROVIDER_COLLECTION_WORKSPACE_ID: binding.provider.workspace.id,
    PROVIDER_COLLECTION_CANONICAL_SHA256: binding.provider.collection.canonicalSha256,
  };
  for (const [name, value] of Object.entries(bindingValues)) {
    if (values.get(name) !== value) fail(`Postman binding and Harness Input Set disagree: ${name}`);
  }
  for (const name of ['ledger-sync.mjs', 'setup-workspace-simulation.mjs', 'sync-cloud-collection.mjs']) {
    if (actual.some((path) => path.endsWith(`/${name}`))) fail(`mutating tool was packaged: ${name}`);
  }
  for (const name of actual.filter((path) => path.startsWith('toolkit/'))) {
    if (!allowedToolkitPath(name)) fail(`toolkit file is outside the customer capability allowlist: ${name}`);
  }

  for (const name of actual) {
    const source = readFileSync(join(ROOT, name), 'utf8');
    if (/PMAK-[A-Za-z0-9-]{16,}|pat\.[A-Za-z0-9_.-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source)) {
      fail(`credential-shaped value detected: ${name}`);
    }
  }

  console.log(`[PASS] customer kit integrity ${manifest.files.length}/${manifest.files.length} files`);
  console.log(`[PASS] release ${manifest.release.sourceRef} -> ${manifest.release.reviewedSourceCommit}`);
  console.log(`[PASS] Harness runtime coverage ${values.size}/${EXPECTED_VARIABLES.length}`);
  console.log('[PASS] resolved customer config, Postman bindings, and Harness inputs agree');
  console.log('[PASS] mutating administration tools excluded');
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = 1;
}
