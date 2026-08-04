#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc } from '../../src/lib/load.mjs';
import {
  postmanApiUrl,
  redactPostmanSecrets,
  validatePostmanApiBase,
  validatePostmanApiUrl,
} from './postman-api-base.mjs';
import { assertCanonicalDigest, pullSingleRootSpecFile } from './spec-file.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(value, name) {
  if (!value || typeof value !== 'string') throw new Error(`${name} is required`);
  if (!/^[A-Za-z0-9_-]{3,200}$/.test(value)) throw new Error(`${name} contains invalid characters`);
  return value;
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 5_000);
  return Math.min(250 * (2 ** (attempt - 1)), 5_000);
}

export async function requestPostmanJson(url, {
  apiKey,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = 4,
  timeoutMs = 15_000,
} = {}) {
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error('Postman API attempts must be an integer from 1 to 10');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('Postman API timeoutMs must be an integer from 1 to 120000');
  }
  const target = validatePostmanApiUrl(url);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`Postman API request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    let response;
    try {
      response = await Promise.race([
        fetchImpl(target, {
          headers: { 'x-api-key': apiKey },
          redirect: 'error',
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (response.ok) return await Promise.race([response.json(), timeout]);
      lastError = new Error(`Postman API returned HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleepImpl(retryDelay(response, attempt));
  }
  throw new Error(
    `Postman API request failed: ${redactPostmanSecrets(lastError?.message ?? 'unknown error', apiKey)}`,
  );
}

function validateOas(content, role) {
  let document;
  try {
    document = parseDoc(content);
  } catch (error) {
    throw new Error(`${role} specification is not valid JSON or YAML: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${role} specification must be an object`);
  }
  const version = document.openapi ?? document.swagger;
  if (typeof version !== 'string' || !/^(2\.0|3\.\d+\.\d+)$/.test(version)) {
    throw new Error(`${role} specification is not OpenAPI 2.0 or 3.x`);
  }
  if (!document.info?.title || typeof document.paths !== 'object' || Array.isArray(document.paths)) {
    throw new Error(`${role} specification requires info.title and paths`);
  }
  return { document, version };
}

async function assertSpecificationWorkspace({
  workspaceId,
  specId,
  apiBase,
  request,
}) {
  const url = postmanApiUrl('/workspaces', apiBase);
  url.searchParams.set('elementType', 'specification');
  url.searchParams.set('elementId', specId);
  url.searchParams.set('limit', '100');
  const body = await request(url);
  const workspaces = Array.isArray(body?.workspaces) ? body.workspaces : [];
  if (!workspaces.some((workspace) => workspace?.id === workspaceId)) {
    throw new Error(`specification ${specId} is not in expected workspace ${workspaceId}`);
  }
}

async function fetchSpecification({
  role,
  workspaceId,
  specId,
  expectedCanonicalSha256,
  apiBase,
  request,
}) {
  await assertSpecificationWorkspace({ workspaceId, specId, apiBase, request });
  const root = await pullSingleRootSpecFile({
    specId,
    apiBase,
    request,
    label: `${role} specification`,
  });
  const content = root.content;
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  const { document, version } = validateOas(normalized, role);
  const canonicalSha256 = assertCanonicalDigest({
    content: normalized,
    expected: expectedCanonicalSha256,
    label: `${role} specification`,
  });
  return {
    role,
    workspaceId,
    specId,
    rootFilePath: root.path,
    content: normalized,
    sha256: createHash('sha256').update(normalized).digest('hex'),
    canonicalSha256,
    bytes: Buffer.byteLength(normalized),
    openapiVersion: version,
    title: document.info.title,
    documentVersion: document.info.version ?? null,
  };
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

export async function pullWorkspaceOas({
  consumerWorkspaceId,
  consumerSpecId,
  providerWorkspaceId,
  providerSpecId,
  consumerExpectedCanonicalSha256,
  providerExpectedCanonicalSha256,
  outDir = '.contract-inputs/postman',
  apiKey,
  apiBase = 'https://api.postman.com',
  fetchImpl = fetch,
  sleepImpl,
  now = () => new Date(),
} = {}) {
  const inputs = {
    consumerWorkspaceId: required(consumerWorkspaceId, 'consumer workspace ID'),
    consumerSpecId: required(consumerSpecId, 'consumer specification ID'),
    providerWorkspaceId: required(providerWorkspaceId, 'provider workspace ID'),
    providerSpecId: required(providerSpecId, 'provider specification ID'),
  };
  if (inputs.consumerWorkspaceId === inputs.providerWorkspaceId) {
    throw new Error('consumer and provider workspace IDs must be distinct');
  }
  if (inputs.consumerSpecId === inputs.providerSpecId) {
    throw new Error('consumer and provider specification IDs must be distinct');
  }
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  const base = validatePostmanApiBase(apiBase);
  const request = (url) => requestPostmanJson(url, { apiKey, fetchImpl, sleepImpl });
  const artifacts = await Promise.all([
    fetchSpecification({
      role: 'consumer', workspaceId: inputs.consumerWorkspaceId,
      specId: inputs.consumerSpecId,
      expectedCanonicalSha256: consumerExpectedCanonicalSha256,
      apiBase: base,
      request,
    }),
    fetchSpecification({
      role: 'provider', workspaceId: inputs.providerWorkspaceId,
      specId: inputs.providerSpecId,
      expectedCanonicalSha256: providerExpectedCanonicalSha256,
      apiBase: base,
      request,
    }),
  ]);

  for (const artifact of artifacts) {
    artifact.path = join(outDir, `${artifact.role}-oas.yaml`);
    atomicWrite(artifact.path, artifact.content);
    delete artifact.content;
  }
  const manifest = {
    schemaVersion: 1,
    retrievedAt: now().toISOString(),
    apiBase: base.origin,
    artifacts,
  };
  const manifestPath = join(outDir, 'postman-oas-provenance.json');
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestPath, ...manifest };
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = await pullWorkspaceOas({
    consumerWorkspaceId: arg('consumer-workspace-id'),
    consumerSpecId: arg('consumer-spec-id'),
    providerWorkspaceId: arg('provider-workspace-id'),
    providerSpecId: arg('provider-spec-id'),
    consumerExpectedCanonicalSha256: arg('consumer-expected-canonical-sha256'),
    providerExpectedCanonicalSha256: arg('provider-expected-canonical-sha256'),
    outDir: arg('out-dir', '.contract-inputs/postman'),
    apiKey: process.env.POSTMAN_API_KEY,
    apiBase: process.env.POSTMAN_API_BASE_URL || 'https://api.postman.com',
  });
  for (const artifact of result.artifacts) {
    console.log(`[postman-oas] ${artifact.role} ${artifact.title} -> ${artifact.path} sha256=${artifact.sha256}`);
  }
  console.log(`[postman-oas] provenance -> ${result.manifestPath}`);
}
