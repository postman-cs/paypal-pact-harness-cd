#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc } from '../../src/lib/load.mjs';
import { syncCloudCollection } from './sync-cloud-collection.mjs';

const DEFAULTS = {
  consumer: {
    participant: 'orders-checkout-consumer',
    workspaceName: 'PayPal Pact Simulation - Consumer',
    workspaceDescription: 'Consumer-owned Orders contracts for the PayPal Pact Harness simulation.',
    specName: 'checkout-consumer',
    specFixture: 'fixtures/paypal/checkout-consumer-oas.json',
    collectionFixture: 'fixtures/paypal/orders-checkout-consumer.postman_collection.json',
  },
  provider: {
    participant: 'paypal-orders',
    workspaceName: 'PayPal Pact Simulation - Provider',
    workspaceDescription: 'Provider Orders specification and conformance tests for the PayPal Pact Harness simulation.',
    specName: 'Orders',
    specFixture: 'fixtures/paypal/checkout_orders_v2.json',
    collectionFixture: 'fixtures/paypal/orders-lower.postman_collection.json',
  },
};

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function apiUrl(path, apiBase) {
  const url = new URL(path, apiBase);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('POSTMAN_API_BASE_URL must use HTTPS');
  }
  return url;
}

export async function requestJson(url, {
  apiKey,
  method = 'GET',
  body,
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const detail = (await response.text()).replace(/PMAK-[A-Za-z0-9_-]+/g, '[REDACTED]');
      throw new Error(`Postman ${method} ${new URL(url).pathname} returned HTTP ${response.status}: ${detail.slice(0, 500)}`);
    }
    if (response.status === 204) return null;
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function paged({ url, field, request }) {
  const values = [];
  let cursor;
  do {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set('limit', '100');
    if (cursor) pageUrl.searchParams.set('cursor', cursor);
    const body = await request(pageUrl);
    values.push(...(Array.isArray(body?.[field]) ? body[field] : []));
    cursor = body?.meta?.nextCursor || null;
  } while (cursor);
  return values;
}

async function ensureWorkspace({ name, description, workspaceType, apiBase, request }) {
  const workspaces = await paged({
    url: apiUrl('/workspaces', apiBase),
    field: 'workspaces',
    request,
  });
  const matches = workspaces.filter((workspace) => workspace?.name === name);
  if (matches.length > 1) throw new Error(`multiple Postman workspaces named ${name}`);
  if (matches.length === 1) return { action: 'reused', id: matches[0].id, name };
  const created = await request(apiUrl('/workspaces', apiBase), {
    method: 'POST',
    body: {
      workspace: {
        name,
        type: workspaceType,
        description,
        about: description,
      },
    },
  });
  if (!created?.workspace?.id) throw new Error(`Postman did not return an ID for workspace ${name}`);
  return { action: 'created', id: created.workspace.id, name };
}

function oasType(document) {
  const version = String(document?.openapi ?? document?.swagger ?? '');
  if (version === '2.0') return 'OPENAPI:2.0';
  if (version.startsWith('3.1.')) return 'OPENAPI:3.1';
  if (version.startsWith('3.0.')) return 'OPENAPI:3.0';
  throw new Error(`unsupported OpenAPI version ${version || '(missing)'}`);
}

async function ensureSpec({ workspaceId, name, content, apiBase, request }) {
  const listUrl = apiUrl('/specs', apiBase);
  listUrl.searchParams.set('workspaceId', workspaceId);
  const specs = await paged({ url: listUrl, field: 'specs', request });
  const matches = specs.filter((spec) => spec?.name === name);
  if (matches.length > 1) throw new Error(`multiple specifications named ${name} in workspace ${workspaceId}`);
  if (matches.length === 0) {
    const createUrl = apiUrl('/specs', apiBase);
    createUrl.searchParams.set('workspaceId', workspaceId);
    const document = parseDoc(content);
    const created = await request(createUrl, {
      method: 'POST',
      body: {
        name,
        type: oasType(document),
        files: [{ path: 'openapi.json', type: 'DEFAULT', content }],
      },
    });
    if (!created?.id) throw new Error(`Postman did not return an ID for specification ${name}`);
    return { action: 'created', id: created.id, name };
  }

  const specId = matches[0].id;
  const files = await request(apiUrl(`/specs/${encodeURIComponent(specId)}/files`, apiBase));
  const fileList = Array.isArray(files?.files) ? files.files : [];
  const root = fileList.find((file) => file?.type === 'ROOT') ?? fileList.find((file) => file?.path === 'openapi.json');
  if (!root?.path) throw new Error(`specification ${specId} has no root file to update`);
  await request(apiUrl(`/specs/${encodeURIComponent(specId)}/files/${root.path.split('/').map(encodeURIComponent).join('/')}`, apiBase), {
    method: 'PATCH',
    body: { content },
  });
  return { action: 'updated', id: specId, name };
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.part-${process.pid}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function setupWorkspaceSimulation({
  rootDir = process.cwd(),
  outPath = 'config/postman-workspace-simulation.json',
  apiKey,
  apiBase = 'https://api.postman.com',
  workspaceType = 'team',
  fetchImpl = fetch,
  definitions = DEFAULTS,
  now = () => new Date(),
} = {}) {
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  if (!['team', 'personal', 'private'].includes(workspaceType)) {
    throw new Error('workspaceType must be team, personal, or private');
  }
  const base = new URL(apiBase);
  const request = (url, options = {}) => requestJson(url, { apiKey, fetchImpl, ...options });
  const result = { schemaVersion: 1, reconciledAt: now().toISOString(), apiBase: base.origin };

  for (const role of ['consumer', 'provider']) {
    const definition = definitions[role];
    const specPath = resolve(rootDir, definition.specFixture);
    const collectionPath = resolve(rootDir, definition.collectionFixture);
    const specContent = readFileSync(specPath, 'utf8');
    const specDocument = parseDoc(specContent);
    const collectionContent = readFileSync(collectionPath, 'utf8');
    const collection = JSON.parse(collectionContent);
    const workspace = await ensureWorkspace({
      name: definition.workspaceName,
      description: definition.workspaceDescription,
      workspaceType,
      apiBase,
      request,
    });
    const spec = await ensureSpec({
      workspaceId: workspace.id,
      name: definition.specName,
      content: specContent,
      apiBase,
      request,
    });
    const collectionResult = await syncCloudCollection({
      collection,
      workspaceId: workspace.id,
      apiKey,
      apiBase,
      fetchImpl,
    });
    result[role] = {
      participant: definition.participant,
      workspace,
      spec: {
        ...spec,
        fixture: definition.specFixture,
        title: specDocument.info?.title ?? null,
        version: specDocument.info?.version ?? null,
        sourceSha256: sha256(specContent),
      },
      collection: {
        action: collectionResult.action,
        uid: collectionResult.uid,
        name: collection.info.name,
        fixture: definition.collectionFixture,
        sourceSha256: sha256(collectionContent),
      },
    };
  }

  atomicWrite(resolve(rootDir, outPath), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const output = await setupWorkspaceSimulation({
    rootDir: arg('root', process.cwd()),
    outPath: arg('out', 'config/postman-workspace-simulation.json'),
    apiKey: process.env.POSTMAN_API_KEY,
    apiBase: process.env.POSTMAN_API_BASE_URL || 'https://api.postman.com',
    workspaceType: arg('workspace-type', process.env.POSTMAN_WORKSPACE_TYPE || 'team'),
  });
  for (const role of ['consumer', 'provider']) {
    const item = output[role];
    console.log(`[postman-setup] ${role} workspace=${item.workspace.id} (${item.workspace.action}) spec=${item.spec.id} (${item.spec.action}) collection=${item.collection.uid} (${item.collection.action})`);
  }
  console.log('[postman-setup] wrote non-secret binding config/postman-workspace-simulation.json');
}
