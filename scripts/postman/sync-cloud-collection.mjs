#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCollectionCanonicalDigest,
  canonicalCollectionSha256,
} from './collection-canonical.mjs';
import {
  postmanApiUrl,
  redactPostmanSecrets,
  validatePostmanApiBase,
  validatePostmanApiUrl,
} from './postman-api-base.mjs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function requestJson(url, {
  apiKey,
  method = 'GET',
  body,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
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
        signal: controller.signal,
        redirect: 'error',
        headers: {
          'x-api-key': apiKey,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      timeout,
    ]);
    if (!response.ok) {
      throw new Error(`Postman ${method} ${target.pathname} returned HTTP ${response.status}`);
    }
    return await Promise.race([response.json(), timeout]);
  } catch (error) {
    throw new Error(redactPostmanSecrets(error?.message ?? error, apiKey));
  } finally {
    clearTimeout(timer);
  }
}

export async function syncCloudCollection({
  collection,
  workspaceId,
  apiKey,
  apiBase = 'https://api.postman.com',
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  if (!collection?.info?.name) throw new Error('collection.info.name is required');
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  const base = validatePostmanApiBase(apiBase);

  const listUrl = postmanApiUrl('/collections', base);
  listUrl.searchParams.set('workspace', workspaceId);
  listUrl.searchParams.set('name', collection.info.name);
  const listed = await requestJson(listUrl, { apiKey, fetchImpl, timeoutMs });
  if (!listed || typeof listed !== 'object' || !Array.isArray(listed.collections)) {
    throw new Error('Postman collections list response is malformed');
  }
  const matches = listed.collections.filter((entry) => entry.name === collection.info.name);
  if (matches.length > 1) {
    throw new Error(`multiple collections named ${collection.info.name} in workspace ${workspaceId}`);
  }
  const existing = matches[0];
  if (existing && !existing.uid) {
    throw new Error(`Postman collection ${collection.info.name} has no UID`);
  }

  const target = existing
    ? postmanApiUrl(`/collections/${encodeURIComponent(existing.uid)}`, base)
    : postmanApiUrl('/collections', base);
  if (!existing) target.searchParams.set('workspace', workspaceId);
  const action = existing ? 'updated' : 'created';
  const result = await requestJson(target, {
    apiKey,
    method: existing ? 'PUT' : 'POST',
    body: { collection },
    fetchImpl,
    timeoutMs,
  });
  const uid = result.collection?.uid ?? existing?.uid;
  if (!uid) throw new Error('Postman response did not include collection.uid');
  const approvedCanonicalSha256 = canonicalCollectionSha256(collection);
  const retrieved = await requestJson(
    postmanApiUrl(`/collections/${encodeURIComponent(uid)}`, base),
    { apiKey, fetchImpl, timeoutMs },
  );
  if (!retrieved?.collection || typeof retrieved.collection !== 'object') {
    throw new Error('Postman collection verification response is malformed');
  }
  const canonicalSha256 = assertCollectionCanonicalDigest({
    collection: retrieved.collection,
    expected: approvedCanonicalSha256,
    label: 'Postman collection round-trip',
  });
  return {
    schemaVersion: 1,
    action,
    uid,
    workspaceId,
    name: collection.info.name,
    canonicalSha256,
  };
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const collectionPath = arg('collection');
  const workspaceId = arg('workspace-id');
  const outPath = arg('json-out');
  if (!collectionPath) throw new Error('--collection is required');
  if (!workspaceId) throw new Error('--workspace-id is required');

  const result = await syncCloudCollection({
    collection: JSON.parse(readFileSync(collectionPath, 'utf8')),
    workspaceId,
    apiKey: process.env.POSTMAN_API_KEY,
    apiBase: process.env.POSTMAN_API_BASE_URL,
  });
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(`postman-cloud-sync: ${result.action} ${result.uid}`);
}
