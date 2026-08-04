#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      signal: controller.signal,
      redirect: 'error',
      headers: {
        'x-api-key': apiKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Postman ${method} ${url} returned HTTP ${response.status}: ${detail.slice(0, 500)}`);
    }
    return response.json();
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

  const listUrl = new URL('/collections', apiBase);
  listUrl.searchParams.set('workspace', workspaceId);
  const listed = await requestJson(listUrl, { apiKey, fetchImpl, timeoutMs });
  const existing = (listed.collections ?? []).find((entry) => entry.name === collection.info.name);

  const target = existing
    ? new URL(`/collections/${encodeURIComponent(existing.uid)}`, apiBase)
    : listUrl;
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
  return { schemaVersion: 1, action, uid, workspaceId, name: collection.info.name };
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
