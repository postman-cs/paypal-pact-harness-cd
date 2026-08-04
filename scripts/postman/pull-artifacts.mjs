#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc } from '../../src/lib/load.mjs';
import {
  assertCollectionCanonicalDigest,
  requireCollectionCanonicalSha256,
} from './collection-canonical.mjs';
import { postmanApiUrl, validatePostmanApiBase } from './postman-api-base.mjs';
import { requestPostmanJson } from './pull-workspace-oas.mjs';
import { assertCanonicalDigest, pullSingleRootSpecFile } from './spec-file.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{3,200}$/.test(value)) {
    throw new Error(`${label} is required and contains invalid characters`);
  }
  return value;
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

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function assertWorkspaceMembership({ kind, id, workspaceId, request, apiBase }) {
  const url = postmanApiUrl('/workspaces', apiBase);
  url.searchParams.set('elementType', kind);
  url.searchParams.set('elementId', id);
  url.searchParams.set('limit', '100');
  const body = await request(url);
  if (!Array.isArray(body?.workspaces)) {
    throw new Error(`Postman ${kind} workspace response is malformed`);
  }
  if (!body.workspaces.some((workspace) => workspace?.id === workspaceId)) {
    throw new Error(`${kind} ${id} is not in expected workspace ${workspaceId}`);
  }
}

export async function pullPostmanArtifacts({
  collectionUid,
  collectionWorkspaceId,
  specId,
  specWorkspaceId,
  expectedCollectionCanonicalSha256,
  expectedSpecCanonicalSha256,
  outDir = '.local',
  apiKey,
  apiBase = 'https://api.postman.com',
  fetchImpl = fetch,
  sleepImpl,
  now = () => new Date(),
} = {}) {
  const ids = {
    collectionUid: required(collectionUid, 'collection UID'),
    collectionWorkspaceId: required(collectionWorkspaceId, 'collection workspace ID'),
    specId: required(specId, 'specification ID'),
    specWorkspaceId: required(specWorkspaceId, 'specification workspace ID'),
  };
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  requireCollectionCanonicalSha256(
    expectedCollectionCanonicalSha256,
    'consumer collection approved canonical digest',
  );
  const base = validatePostmanApiBase(apiBase);
  const request = (url) => requestPostmanJson(url, { apiKey, fetchImpl, sleepImpl });

  await Promise.all([
    assertWorkspaceMembership({
      kind: 'collection', id: ids.collectionUid,
      workspaceId: ids.collectionWorkspaceId, request, apiBase: base,
    }),
    assertWorkspaceMembership({
      kind: 'specification', id: ids.specId,
      workspaceId: ids.specWorkspaceId, request, apiBase: base,
    }),
  ]);
  const [collectionBody, exactSpec] = await Promise.all([
    request(postmanApiUrl(`/collections/${encodeURIComponent(ids.collectionUid)}`, base)),
    pullSingleRootSpecFile({
      specId: ids.specId,
      apiBase: base,
      request,
      label: 'provider specification',
    }),
  ]);

  const collection = collectionBody?.collection;
  if (
    typeof collection?.info?.name !== 'string' ||
    !collection.info.name.trim() ||
    !Array.isArray(collection.item)
  ) {
    throw new Error('Postman collection response was empty or malformed');
  }
  const collectionCanonicalSha256 = assertCollectionCanonicalDigest({
    collection,
    expected: expectedCollectionCanonicalSha256,
    label: 'consumer collection',
  });
  const definition = exactSpec.content;
  const document = parseDoc(definition);
  const version = document?.openapi ?? document?.swagger;
  if (
    typeof version !== 'string' ||
    !/^(2\.0|3\.\d+\.\d+)$/.test(version) ||
    typeof document.info?.title !== 'string' ||
    !document.info.title.trim() ||
    !document.paths ||
    typeof document.paths !== 'object' ||
    Array.isArray(document.paths)
  ) {
    throw new Error('Postman specification is not a valid OpenAPI document');
  }
  const canonicalSha256 = assertCanonicalDigest({
    content: definition,
    expected: expectedSpecCanonicalSha256,
    label: 'provider specification',
  });

  const collectionContent = `${JSON.stringify(collection, null, 2)}\n`;
  const specContent = definition.endsWith('\n') ? definition : `${definition}\n`;
  const collectionPath = join(outDir, 'collection.json');
  const specPath = join(outDir, 'provider-oas.yaml');
  atomicWrite(collectionPath, collectionContent);
  atomicWrite(specPath, specContent);
  const manifest = {
    schemaVersion: 1,
    retrievedAt: now().toISOString(),
    apiBase: base.origin,
    artifacts: [
      {
        kind: 'collection', id: ids.collectionUid, workspaceId: ids.collectionWorkspaceId,
        name: collection.info.name, path: collectionPath,
        bytes: Buffer.byteLength(collectionContent), sha256: digest(collectionContent),
        canonicalSha256: collectionCanonicalSha256,
      },
      {
        kind: 'specification', id: ids.specId, workspaceId: ids.specWorkspaceId,
        name: document.info.title, openapiVersion: version, path: specPath,
        rootFilePath: exactSpec.path, bytes: Buffer.byteLength(specContent),
        sha256: digest(specContent), canonicalSha256,
      },
    ],
  };
  const manifestPath = join(outDir, 'postman-artifact-provenance.json');
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, manifestPath };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = await pullPostmanArtifacts({
    collectionUid: arg('collection-uid'),
    collectionWorkspaceId: arg('collection-workspace-id'),
    specId: arg('spec-id'),
    specWorkspaceId: arg('spec-workspace-id'),
    expectedCollectionCanonicalSha256: arg('expected-collection-canonical-sha256'),
    expectedSpecCanonicalSha256: arg('expected-spec-canonical-sha256'),
    outDir: arg('out-dir', '.local'),
    apiKey: process.env.POSTMAN_API_KEY,
    apiBase: process.env.POSTMAN_API_BASE_URL || 'https://api.postman.com',
  });
  console.log(`[pull] collection + provider OAS -> ${result.artifacts[0].path}, ${result.artifacts[1].path}`);
  console.log(`[pull] provenance -> ${result.manifestPath}`);
}
