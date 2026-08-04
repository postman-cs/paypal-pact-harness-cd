#!/usr/bin/env node

import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalCollectionSha256 } from './collection-canonical.mjs';
import { postmanApiUrl, validatePostmanApiBase } from './postman-api-base.mjs';
import { pullWorkspaceOas, requestPostmanJson } from './pull-workspace-oas.mjs';
import { resolveDedicatedSubtreePath } from '../../src/lib/path-safety.mjs';

function required(value, label, pattern = /^[A-Za-z0-9_-]{3,200}$/) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is required or contains invalid characters`);
  return value;
}

function requestCount(items) {
  return (items ?? []).reduce((total, item) => total + (item?.request ? 1 : 0) + requestCount(item?.item), 0);
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.part-${process.pid}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function lockWorkspaceAssets({
  rootDir = process.cwd(),
  outPath,
  owner,
  consumerParticipant,
  consumerWorkspaceId,
  consumerSpecId,
  providerParticipant,
  providerWorkspaceId,
  providerSpecId,
  providerCollectionUid,
  apiKey,
  apiBase = 'https://api.postman.com',
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  const base = validatePostmanApiBase(apiBase);
  const ids = {
    consumerWorkspaceId: required(consumerWorkspaceId, 'consumer workspace ID'),
    consumerSpecId: required(consumerSpecId, 'consumer specification ID'),
    providerWorkspaceId: required(providerWorkspaceId, 'provider workspace ID'),
    providerSpecId: required(providerSpecId, 'provider specification ID'),
    providerCollectionUid: required(providerCollectionUid, 'provider collection UID'),
  };
  const participants = {
    consumer: required(consumerParticipant, 'consumer participant', /^[A-Za-z0-9_.-]{1,200}$/),
    provider: required(providerParticipant, 'provider participant', /^[A-Za-z0-9_.-]{1,200}$/),
  };
  if (participants.consumer === participants.provider) throw new Error('consumer and provider participants must be distinct');
  required(owner, 'owner', /^[A-Za-z0-9_.@/-]{2,200}$/);

  const scratch = mkdtempSync(resolve(tmpdir(), 'postman-asset-lock-'));
  try {
    const oas = await pullWorkspaceOas({
      ...ids,
      outDir: scratch,
      apiKey,
      apiBase: base,
      fetchImpl,
      now,
    });
    const request = (url) => requestPostmanJson(url, { apiKey, fetchImpl });
    const membershipUrl = postmanApiUrl('/workspaces', base);
    membershipUrl.searchParams.set('elementType', 'collection');
    membershipUrl.searchParams.set('elementId', ids.providerCollectionUid);
    membershipUrl.searchParams.set('limit', '100');
    const membership = await request(membershipUrl);
    if (!Array.isArray(membership?.workspaces) ||
        !membership.workspaces.some((workspace) => workspace?.id === ids.providerWorkspaceId)) {
      throw new Error(`collection ${ids.providerCollectionUid} is not in expected workspace ${ids.providerWorkspaceId}`);
    }
    const collectionBody = await request(postmanApiUrl(`/collections/${encodeURIComponent(ids.providerCollectionUid)}`, base));
    const collection = collectionBody?.collection;
    if (!collection?.info?.name || requestCount(collection.item) === 0) {
      throw new Error('provider collection is empty or malformed');
    }
    const byRole = Object.fromEntries(oas.artifacts.map((artifact) => [artifact.role, artifact]));
    const binding = {
      schemaVersion: 1,
      classification: 'customer-owned Postman asset binding',
      owner,
      customerOwned: true,
      lockedAt: now().toISOString(),
      apiBase: base.origin,
      consumer: {
        participant: participants.consumer,
        workspace: { id: ids.consumerWorkspaceId },
        spec: {
          id: ids.consumerSpecId,
          name: byRole.consumer.title,
          rootFilePath: byRole.consumer.rootFilePath,
          sourceCanonicalSha256: byRole.consumer.canonicalSha256,
        },
      },
      provider: {
        participant: participants.provider,
        workspace: { id: ids.providerWorkspaceId },
        spec: {
          id: ids.providerSpecId,
          name: byRole.provider.title,
          rootFilePath: byRole.provider.rootFilePath,
          sourceCanonicalSha256: byRole.provider.canonicalSha256,
        },
        collection: {
          uid: ids.providerCollectionUid,
          name: collection.info.name,
          canonicalSha256: canonicalCollectionSha256(collection),
        },
      },
    };
    const content = `${JSON.stringify(binding, null, 2)}\n`;
    if (outPath) {
      const output = resolveDedicatedSubtreePath({
        root: rootDir,
        input: outPath,
        subtree: '.contract-handoff',
        label: 'asset lock output',
      });
      atomicWrite(output, content);
    }
    return { binding, content };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function help() {
  console.log('Read and lock customer-owned Postman assets without changing Postman.\n\n' +
    'Required: --owner, --consumer-participant, --consumer-workspace-id, --consumer-spec-id,\n' +
    '--provider-participant, --provider-workspace-id, --provider-spec-id, --provider-collection-uid.\n' +
    'Optional: --out .contract-handoff/postman-binding.json (otherwise prints JSON to stdout).');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      help();
    } else {
      const result = await lockWorkspaceAssets({
        outPath: arg('out'),
        owner: arg('owner'),
        consumerParticipant: arg('consumer-participant'),
        consumerWorkspaceId: arg('consumer-workspace-id'),
        consumerSpecId: arg('consumer-spec-id'),
        providerParticipant: arg('provider-participant'),
        providerWorkspaceId: arg('provider-workspace-id'),
        providerSpecId: arg('provider-spec-id'),
        providerCollectionUid: arg('provider-collection-uid'),
        apiKey: process.env.POSTMAN_API_KEY,
        apiBase: process.env.POSTMAN_API_BASE_URL || 'https://api.postman.com',
      });
      if (arg('out')) console.log(`[postman-lock] wrote ${arg('out')}`);
      else process.stdout.write(result.content);
    }
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    console.error('Next: verify the customer-owned Postman IDs and service-account scope, then rerun.');
    process.exitCode = 2;
  }
}
