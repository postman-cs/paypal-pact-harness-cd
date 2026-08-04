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
    if (name === 'KIT-MANIFEST.json' || name.includes('/.contract-reports/') || name.endsWith('/.contract-reports')) continue;
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`symbolic links are not allowed in the kit: ${name}`);
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
  const pipelineId = pipeline.match(/^\s*identifier:\s*([^\s]+)\s*$/m)?.[1]?.replaceAll('"', '');
  const inputPipelineId = inputSet.match(/^\s{4}identifier:\s*([^\s]+)\s*$/m)?.[1]?.replaceAll('"', '');
  if (!pipelineId || pipelineId !== manifest.pipelineIdentifier || inputPipelineId !== manifest.pipelineIdentifier) {
    fail('pipeline and Input Set identifiers do not match the manifest');
  }

  const binding = JSON.parse(readFileSync(join(ROOT, 'demo', 'postman-bindings.json'), 'utf8'));
  const handoffConfig = JSON.parse(readFileSync(join(ROOT, 'provenance', 'customer-handoff-config.json'), 'utf8'));
  rejectCredentialFields(binding, 'Postman binding');
  rejectCredentialFields(handoffConfig, 'handoff config');
  validatePostmanBinding(binding);
  for (const name of ['setup-workspace-simulation.mjs', 'sync-cloud-collection.mjs']) {
    if (actual.some((path) => path.endsWith(`/${name}`))) fail(`cloud-mutating tool was packaged: ${name}`);
  }

  const textFiles = actual.filter((name) => /\.(?:json|md|mjs|yaml|yml|txt)$/.test(name));
  for (const name of textFiles) {
    const source = readFileSync(join(ROOT, name), 'utf8');
    if (/PMAK-[A-Za-z0-9-]{16,}|pat\.[A-Za-z0-9_.-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(source)) {
      fail(`credential-shaped value detected: ${name}`);
    }
  }

  console.log(`[PASS] customer kit integrity ${manifest.files.length}/${manifest.files.length} files`);
  console.log(`[PASS] release ${manifest.release.sourceRef} -> ${manifest.release.reviewedSourceCommit}`);
  console.log(`[PASS] Harness runtime coverage ${values.size}/${EXPECTED_VARIABLES.length}`);
  console.log('[PASS] Postman bindings complete; cloud-mutating administration tools excluded');
}

try {
  main();
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  process.exitCode = 1;
}
