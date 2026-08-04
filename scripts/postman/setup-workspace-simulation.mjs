#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc } from '../../src/lib/load.mjs';
import { canonicalCollectionSha256 } from './collection-canonical.mjs';
import { syncCloudCollection } from './sync-cloud-collection.mjs';
import {
  postmanApiUrl,
  redactPostmanSecrets,
  validatePostmanApiBase,
  validatePostmanApiUrl,
} from './postman-api-base.mjs';
import {
  assertCanonicalDigest,
  canonicalDocumentSha256,
  postmanSpecFileUrl,
  pullSingleRootSpecFile,
} from './spec-file.mjs';

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

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function isoDay(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
  return value;
}

function publicDemoAuthorization({
  apply,
  expectedOwnerId,
  owner,
  classification,
  approvedForPublicEvidence,
  approvalExpiresAt,
  workspaceType,
  teamId,
  rootDir,
  outPath,
  maintenanceMode,
  now,
}) {
  if (!apply) throw new Error('Postman setup is mutating; pass --apply after reviewing the target account and assets');
  if (!/^[A-Za-z0-9_-]{3,200}$/.test(expectedOwnerId ?? '')) {
    throw new Error('expectedOwnerId is required and contains invalid characters');
  }
  if (owner !== 'postman-cs' || classification !== 'public-demo' || approvedForPublicEvidence !== true) {
    throw new Error('demo setup requires owner=postman-cs, classification=public-demo, and explicit public-evidence approval');
  }
  const expires = isoDay(approvalExpiresAt, 'approvalExpiresAt');
  if (Date.parse(`${expires}T23:59:59Z`) < now().getTime()) {
    throw new Error('approvalExpiresAt has expired; obtain a new public-evidence approval before mutation');
  }
  if (workspaceType === 'team' && !teamId) {
    throw new Error('teamId is required when workspaceType=team');
  }
  const trackedBinding = resolve(rootDir, outPath) === resolve(rootDir, 'config/postman-workspace-simulation.json');
  if (trackedBinding && !maintenanceMode) {
    throw new Error('writing the tracked demo binding requires --maintenance-mode and code review');
  }
  return expires;
}

export async function requestJson(url, {
  apiKey,
  method = 'GET',
  body,
  fetchImpl = fetch,
  timeoutMs = 20_000,
} = {}) {
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  const target = validatePostmanApiUrl(url);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Postman API request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(target, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'x-api-key': apiKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      timeout,
    ]);
    if (!response.ok) {
      throw new Error(`Postman ${method} ${target.pathname} returned HTTP ${response.status}`);
    }
    if (response.status === 204) return null;
    return await Promise.race([response.json(), timeout]);
  } catch (error) {
    throw new Error(redactPostmanSecrets(error?.message ?? error, apiKey));
  } finally {
    clearTimeout(timer);
  }
}

async function paged({ url, field, request }) {
  const values = [];
  let cursor;
  const seenCursors = new Set();
  let pages = 0;
  do {
    pages += 1;
    if (pages > 100) throw new Error(`Postman ${field} pagination exceeded 100 pages`);
    const pageUrl = new URL(url);
    pageUrl.searchParams.set('limit', '100');
    if (cursor) pageUrl.searchParams.set('cursor', cursor);
    const body = await request(pageUrl);
    if (!body || typeof body !== 'object' || !Array.isArray(body[field])) {
      throw new Error(`Postman ${field} list response is malformed`);
    }
    values.push(...body[field]);
    const next = body.meta?.nextCursor;
    if (next !== undefined && next !== null && typeof next !== 'string') {
      throw new Error(`Postman ${field} pagination cursor is malformed`);
    }
    cursor = next || null;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(`Postman ${field} pagination repeated a cursor`);
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return values;
}

async function ensureWorkspace({ name, description, workspaceType, teamId, apiBase, request }) {
  const workspaces = await paged({
    url: postmanApiUrl('/workspaces', apiBase),
    field: 'workspaces',
    request,
  });
  const matches = workspaces.filter((workspace) => workspace?.name === name);
  if (matches.length > 1) throw new Error(`multiple Postman workspaces named ${name}`);
  if (matches.length === 1) {
    if (!matches[0].id) throw new Error(`Postman workspace ${name} has no ID`);
    const typeMatches = workspaceType === 'private'
      ? !matches[0].type || ['team', 'private'].includes(matches[0].type)
      : !matches[0].type || matches[0].type === workspaceType;
    const visibilityMatches = workspaceType !== 'private' ||
      !matches[0].visibility || matches[0].visibility === 'private';
    if (!typeMatches || !visibilityMatches) {
      throw new Error(`Postman workspace ${name} has type ${matches[0].type}, expected ${workspaceType}`);
    }
    return { action: 'reused', id: matches[0].id, name };
  }
  const created = await request(postmanApiUrl('/workspaces', apiBase), {
    method: 'POST',
    body: {
      ...(teamId ? { teamId } : {}),
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

function validateSpec(document, role) {
  const type = oasType(document);
  if (typeof document.info?.title !== 'string' || !document.info.title.trim()) {
    throw new Error(`${role} specification requires info.title`);
  }
  if (!document.paths || typeof document.paths !== 'object' || Array.isArray(document.paths)) {
    throw new Error(`${role} specification requires an object paths map`);
  }
  return type;
}

function validateCollection(collection, role) {
  if (typeof collection?.info?.name !== 'string' || !collection.info.name.trim()) {
    throw new Error(`${role} collection requires info.name`);
  }
  if (!Array.isArray(collection.item)) throw new Error(`${role} collection requires an item array`);
}

async function verifyExactSpec({ specId, content, apiBase, request, role }) {
  const root = await pullSingleRootSpecFile({
    specId,
    apiBase,
    request,
    label: `${role} specification`,
  });
  const expectedCanonicalSha256 = canonicalDocumentSha256(content, `${role} source specification`);
  const canonicalSha256 = assertCanonicalDigest({
    content: root.content,
    expected: expectedCanonicalSha256,
    label: `${role} specification`,
  });
  return {
    rootFilePath: root.path,
    sha256: sha256(root.content),
    canonicalSha256,
  };
}

async function ensureSpec({ workspaceId, name, content, specType, apiBase, request, role }) {
  const listUrl = postmanApiUrl('/specs', apiBase);
  listUrl.searchParams.set('workspaceId', workspaceId);
  const specs = await paged({ url: listUrl, field: 'specs', request });
  const matches = specs.filter((spec) => spec?.name === name);
  if (matches.length > 1) throw new Error(`multiple specifications named ${name} in workspace ${workspaceId}`);
  let action;
  let specId;
  if (matches.length === 0) {
    const createUrl = postmanApiUrl('/specs', apiBase);
    createUrl.searchParams.set('workspaceId', workspaceId);
    const created = await request(createUrl, {
      method: 'POST',
      body: {
        name,
        type: specType,
        files: [{ path: 'openapi.json', type: 'ROOT', content }],
      },
    });
    if (!created?.id) throw new Error(`Postman did not return an ID for specification ${name}`);
    action = 'created';
    specId = created.id;
  } else {
    specId = matches[0].id;
    if (!specId) throw new Error(`specification ${name} has no ID`);
    if (matches[0].type && matches[0].type !== specType) {
      throw new Error(`specification ${specId} has type ${matches[0].type}, expected ${specType}`);
    }
    const current = await pullSingleRootSpecFile({
      specId,
      apiBase,
      request,
      label: `${role} specification`,
    });
    await request(postmanSpecFileUrl({ specId, path: current.path, apiBase }), {
      method: 'PATCH',
      body: { content },
    });
    action = 'updated';
  }

  const verified = await verifyExactSpec({ specId, content, apiBase, request, role });
  return { action, id: specId, name, ...verified };
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
  teamId = '',
  fetchImpl = fetch,
  definitions = DEFAULTS,
  now = () => new Date(),
  apply = false,
  expectedOwnerId = '',
  owner = '',
  classification = '',
  approvedForPublicEvidence = false,
  approvalExpiresAt = '',
  maintenanceMode = false,
} = {}) {
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  if (!['team', 'personal', 'private'].includes(workspaceType)) {
    throw new Error('workspaceType must be team, personal, or private');
  }
  if (teamId && !/^[A-Za-z0-9_-]{3,200}$/.test(teamId)) {
    throw new Error('teamId contains invalid characters');
  }
  const expires = publicDemoAuthorization({
    apply, expectedOwnerId, owner, classification, approvedForPublicEvidence,
    approvalExpiresAt, workspaceType, teamId, rootDir, outPath, maintenanceMode, now,
  });
  const base = validatePostmanApiBase(apiBase);
  const request = (url, options = {}) => requestJson(url, { apiKey, fetchImpl, ...options });
  const result = {
    schemaVersion: 1,
    reconciledAt: now().toISOString(),
    apiBase: base.origin,
    classification,
    owner,
    customerOwned: false,
    approvedForPublicEvidence: true,
    approvalReviewedAt: now().toISOString().slice(0, 10),
    approvalExpiresAt: expires,
  };

  const prepared = {};
  for (const role of ['consumer', 'provider']) {
    const definition = definitions[role];
    if (!definition) throw new Error(`${role} workspace definition is required`);
    const specContent = readFileSync(resolve(rootDir, definition.specFixture), 'utf8');
    const collectionContent = readFileSync(resolve(rootDir, definition.collectionFixture), 'utf8');
    const specDocument = parseDoc(specContent);
    const collection = JSON.parse(collectionContent);
    const specType = validateSpec(specDocument, role);
    validateCollection(collection, role);
    prepared[role] = { definition, specContent, collectionContent, specDocument, collection, specType };
  }

  const identity = await request(postmanApiUrl('/me', base));
  const actualOwnerId = String(identity?.user?.id ?? identity?.id ?? '');
  if (actualOwnerId !== String(expectedOwnerId)) {
    throw new Error(`authenticated Postman owner ${actualOwnerId || '(missing)'} does not match expected owner ${expectedOwnerId}`);
  }

  for (const role of ['consumer', 'provider']) {
    const { definition, specContent, collectionContent, specDocument, collection, specType } = prepared[role];
    const workspace = await ensureWorkspace({
      name: definition.workspaceName,
      description: definition.workspaceDescription,
      workspaceType,
      teamId,
      apiBase: base,
      request,
    });
    const spec = await ensureSpec({
      workspaceId: workspace.id,
      name: definition.specName,
      content: specContent,
      specType,
      apiBase: base,
      request,
      role,
    });
    const collectionResult = await syncCloudCollection({
      collection,
      workspaceId: workspace.id,
      apiKey,
      apiBase: base,
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
        sourceCanonicalSha256: canonicalDocumentSha256(specContent, `${role} source specification`),
      },
      collection: {
        action: collectionResult.action,
        uid: collectionResult.uid,
        name: collection.info.name,
        fixture: definition.collectionFixture,
        sourceSha256: sha256(collectionContent),
        canonicalSha256: collectionResult.canonicalSha256,
      },
    };
  }

  atomicWrite(resolve(rootDir, outPath), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    if (flag('help') || process.argv.includes('-h')) {
      console.log('Mutating Postman-CS public-demo setup. No mutation occurs without --apply.\n\n' +
        'Required: --apply --owner-id ID --owner postman-cs --classification public-demo\n' +
        '--approved-for-public-evidence --approval-expires YYYY-MM-DD.\n' +
        'For team workspaces, pass --team-id. Writing the tracked binding also requires --maintenance-mode.');
      process.exitCode = 0;
    } else {
      const output = await setupWorkspaceSimulation({
        rootDir: arg('root', process.cwd()),
        outPath: arg('out', 'config/postman-workspace-simulation.json'),
        apiKey: process.env.POSTMAN_API_KEY,
        apiBase: process.env.POSTMAN_API_BASE_URL || 'https://api.postman.com',
        workspaceType: arg('workspace-type', process.env.POSTMAN_WORKSPACE_TYPE || 'team'),
        teamId: arg('team-id', process.env.POSTMAN_TEAM_ID || ''),
        apply: flag('apply'),
        expectedOwnerId: arg('owner-id', process.env.POSTMAN_EXPECTED_OWNER_ID || ''),
        owner: arg('owner', ''),
        classification: arg('classification', ''),
        approvedForPublicEvidence: flag('approved-for-public-evidence'),
        approvalExpiresAt: arg('approval-expires', ''),
        maintenanceMode: flag('maintenance-mode'),
      });
      for (const role of ['consumer', 'provider']) {
        const item = output[role];
        console.log(`[postman-setup] ${role} workspace=${item.workspace.id} (${item.workspace.action}) spec=${item.spec.id} (${item.spec.action}) collection=${item.collection.uid} (${item.collection.action})`);
      }
      console.log('[postman-setup] wrote approved, non-secret binding config/postman-workspace-simulation.json');
    }
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    console.error('Next: export POSTMAN_API_KEY from the approved service account, then rerun npm run postman:seed-demo.');
    process.exitCode = 2;
  }
}
