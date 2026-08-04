#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pullWorkspaceOas, requestPostmanJson } from './pull-workspace-oas.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} failed with exit ${result.status ?? 1}`);
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function pullCollection({ role, workspaceId, uid, outPath, apiBase, apiKey, fetchImpl }) {
  const workspaceUrl = new URL('/workspaces', apiBase);
  workspaceUrl.searchParams.set('elementType', 'collection');
  workspaceUrl.searchParams.set('elementId', uid);
  workspaceUrl.searchParams.set('limit', '100');
  const request = (url) => requestPostmanJson(url, { apiKey, fetchImpl });
  const membership = await request(workspaceUrl);
  if (!(membership.workspaces ?? []).some((workspace) => workspace?.id === workspaceId)) {
    throw new Error(`collection ${uid} is not in expected workspace ${workspaceId}`);
  }
  const body = await request(new URL(`/collections/${encodeURIComponent(uid)}`, apiBase));
  if (!body?.collection?.info?.name) throw new Error(`${role} collection response was empty or unsupported`);
  const content = `${JSON.stringify(body.collection, null, 2)}\n`;
  writeFileSync(outPath, content, { mode: 0o600 });
  return { role, workspaceId, uid, name: body.collection.info.name, path: outPath, sha256: hash(content) };
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
  const config = JSON.parse(readFileSync(resolve(rootDir, configPath), 'utf8'));
  const output = resolve(rootDir, outDir);
  const inputs = resolve(output, 'inputs');
  mkdirSync(inputs, { recursive: true });

  const oas = await pullWorkspaceOas({
    consumerWorkspaceId: config.consumer.workspace.id,
    consumerSpecId: config.consumer.spec.id,
    providerWorkspaceId: config.provider.workspace.id,
    providerSpecId: config.provider.spec.id,
    outDir: inputs,
    apiKey,
    apiBase,
    fetchImpl,
  });
  const collections = await Promise.all(['consumer', 'provider'].map((role) => pullCollection({
    role,
    workspaceId: config[role].workspace.id,
    uid: config[role].collection.uid,
    outPath: resolve(inputs, `${role}.postman_collection.json`),
    apiBase,
    apiKey,
    fetchImpl,
  })));

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
