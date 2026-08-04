#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertCollectionCanonicalDigest,
  requireCollectionCanonicalSha256,
} from './collection-canonical.mjs';
import { pullWorkspaceOas, requestPostmanJson } from './pull-workspace-oas.mjs';
import { postmanApiUrl, validatePostmanApiBase } from './postman-api-base.mjs';
import { requireCanonicalSha256 } from './spec-file.mjs';
import { resolveDedicatedSubtreePath } from '../../src/lib/path-safety.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(command, args, cwd) {
  const childEnv = { ...process.env };
  delete childEnv.POSTMAN_API_KEY;
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: childEnv });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} failed with exit ${result.status ?? 1}`);
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function requestCount(items) {
  return (items ?? []).reduce((total, item) =>
    total + (item?.request ? 1 : 0) + requestCount(item?.item), 0);
}

async function pullCollection({
  role,
  workspaceId,
  uid,
  expectedCanonicalSha256,
  apiBase,
  apiKey,
  fetchImpl,
}) {
  const workspaceUrl = postmanApiUrl('/workspaces', apiBase);
  workspaceUrl.searchParams.set('elementType', 'collection');
  workspaceUrl.searchParams.set('elementId', uid);
  workspaceUrl.searchParams.set('limit', '100');
  const request = (url) => requestPostmanJson(url, { apiKey, fetchImpl });
  const membership = await request(workspaceUrl);
  if (!(membership.workspaces ?? []).some((workspace) => workspace?.id === workspaceId)) {
    throw new Error(`collection ${uid} is not in expected workspace ${workspaceId}`);
  }
  const body = await request(postmanApiUrl(`/collections/${encodeURIComponent(uid)}`, apiBase));
  if (!body?.collection?.info?.name) throw new Error(`${role} collection response was empty or unsupported`);
  const requests = requestCount(body.collection.item);
  if (requests === 0) throw new Error(`${role} collection contains no executable requests`);
  const canonicalSha256 = assertCollectionCanonicalDigest({
    collection: body.collection,
    expected: expectedCanonicalSha256,
    label: `${role} collection`,
  });
  const content = `${JSON.stringify(body.collection, null, 2)}\n`;
  return {
    role, workspaceId, uid, name: body.collection.info.name,
    requests, content, sha256: hash(content), canonicalSha256,
  };
}

export function resolveWorkspaceSimulationOutput(rootDir, outDir) {
  return resolveDedicatedSubtreePath({
    root: rootDir,
    input: outDir,
    subtree: '.contract-reports/postman-workspace-simulation',
    label: 'simulation outDir',
  });
}

export async function runWorkspaceSimulation({
  rootDir = process.cwd(),
  configPath = 'config/postman-workspace-simulation.json',
  outDir = '.contract-reports/postman-workspace-simulation',
  apiKey,
  apiBase = 'https://api.postman.com',
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  const base = validatePostmanApiBase(apiBase);
  const config = JSON.parse(readFileSync(resolve(rootDir, configPath), 'utf8'));
  for (const role of ['consumer', 'provider']) {
    if (!config[role]?.workspace?.id || !config[role]?.spec?.id || !config[role]?.collection?.uid) {
      throw new Error(`${role} workspace, specification, and collection bindings are required`);
    }
    if (
      typeof config[role].participant !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,200}$/.test(config[role].participant)
    ) {
      throw new Error(`${role} participant is required and contains invalid characters`);
    }
    requireCanonicalSha256(
      config[role].spec.sourceCanonicalSha256,
      `${role} approved specification canonical digest`,
    );
    requireCollectionCanonicalSha256(
      config[role].collection.canonicalSha256,
      `${role} approved collection canonical digest`,
    );
  }
  if (config.consumer.participant === config.provider.participant) {
    throw new Error('consumer and provider participants must be distinct');
  }
  if (config.consumer.workspace.id === config.provider.workspace.id) {
    throw new Error('consumer and provider workspace IDs must be distinct');
  }
  if (config.consumer.spec.id === config.provider.spec.id) {
    throw new Error('consumer and provider specification IDs must be distinct');
  }
  if (config.consumer.collection.uid === config.provider.collection.uid) {
    throw new Error('consumer and provider collection UIDs must be distinct');
  }
  const output = resolveWorkspaceSimulationOutput(rootDir, outDir);
  const collections = await Promise.all(['consumer', 'provider'].map((role) => pullCollection({
    role,
    workspaceId: config[role].workspace.id,
    uid: config[role].collection.uid,
    expectedCanonicalSha256: config[role].collection.canonicalSha256,
    apiBase: base,
    apiKey,
    fetchImpl,
  })));

  for (const stale of [
    'evidence.json',
    'consumer-oas-bdc.json',
    'consumer-oas-bdc.xml',
    'consumer-collection-bdc.json',
    'consumer-collection-bdc.xml',
  ]) {
    rmSync(resolve(output, stale), { force: true });
  }
  const inputs = resolve(output, 'inputs');
  mkdirSync(inputs, { recursive: true });

  const oas = await pullWorkspaceOas({
    consumerWorkspaceId: config.consumer.workspace.id,
    consumerSpecId: config.consumer.spec.id,
    providerWorkspaceId: config.provider.workspace.id,
    providerSpecId: config.provider.spec.id,
    consumerExpectedCanonicalSha256: config.consumer.spec.sourceCanonicalSha256,
    providerExpectedCanonicalSha256: config.provider.spec.sourceCanonicalSha256,
    outDir: inputs,
    apiKey,
    apiBase: base,
    fetchImpl,
  });
  for (const collection of collections) {
    collection.path = resolve(inputs, `${collection.role}.postman_collection.json`);
    writeFileSync(collection.path, collection.content, { mode: 0o600 });
    delete collection.content;
  }

  const cli = resolve(rootDir, 'src/cli.mjs');
  const providerOas = resolve(inputs, 'provider-oas.yaml');
  const consumerOasPact = resolve(inputs, 'consumer-oas.pact.json');
  const consumerCollectionPact = resolve(inputs, 'consumer-collection.pact.json');
  run(process.execPath, [cli, 'oas-to-pact', '--oas', resolve(inputs, 'consumer-oas.yaml'), '--provider', config.provider.participant, '--consumer', config.consumer.participant, '--out', consumerOasPact], rootDir);
  run(process.execPath, [cli, 'bdc-verify', '--oas', providerOas, '--pact', consumerOasPact, '--policy', resolve(rootDir, 'config/contract-policy.json'), '--json-out', resolve(output, 'consumer-oas-bdc.json'), '--junit', resolve(output, 'consumer-oas-bdc.xml')], rootDir);
  run(process.execPath, [cli, 'postman-to-pact', '--collection', resolve(inputs, 'consumer.postman_collection.json'), '--provider', config.provider.participant, '--consumer', config.consumer.participant, '--out', consumerCollectionPact], rootDir);
  run(process.execPath, [cli, 'bdc-verify', '--oas', providerOas, '--pact', consumerCollectionPact, '--policy', resolve(rootDir, 'config/contract-policy.json'), '--json-out', resolve(output, 'consumer-collection-bdc.json'), '--junit', resolve(output, 'consumer-collection-bdc.xml')], rootDir);

  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    classification: 'phase-0 Postman-backed static bi-directional compatibility',
    providerCollectionExecution: {
      status: 'not-run',
      reason: 'run the provider Collection against the candidate service in the runtime gate',
    },
    oasProvenance: oas.manifestPath,
    collections,
    reports: ['consumer-oas-bdc.json', 'consumer-oas-bdc.xml', 'consumer-collection-bdc.json', 'consumer-collection-bdc.xml'],
  };
  writeFileSync(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return evidence;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = await runWorkspaceSimulation({
    rootDir: arg('root', process.cwd()),
    configPath: arg('config', 'config/postman-workspace-simulation.json'),
    outDir: arg('out-dir', '.contract-reports/postman-workspace-simulation'),
    apiKey: process.env.POSTMAN_API_KEY,
    apiBase: process.env.POSTMAN_API_BASE_URL || 'https://api.postman.com',
  });
  console.log(`[postman-simulation] PASS: ${result.classification}`);
  console.log('[postman-simulation] evidence -> .contract-reports/postman-workspace-simulation/evidence.json');
}
