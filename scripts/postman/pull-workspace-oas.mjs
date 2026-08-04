#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc } from '../../src/lib/load.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(value, name) {
  if (!value || typeof value !== 'string') throw new Error(`${name} is required`);
  if (!/^[A-Za-z0-9_-]{3,200}$/.test(value)) throw new Error(`${name} contains invalid characters`);
  return value;
}

function apiUrl(path, apiBase) {
  const base = new URL(apiBase);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new Error('POSTMAN_API_BASE_URL must use HTTPS');
  }
  return new URL(path, base);
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
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'x-api-key': apiKey },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.ok) return response.json();
      lastError = new Error(`Postman API returned HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleepImpl(retryDelay(response, attempt));
  }
  throw new Error(`Postman API request failed: ${lastError?.message ?? 'unknown error'}`);
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
  const url = apiUrl('/workspaces', apiBase);
  url.searchParams.set('elementType', 'specification');
  url.searchParams.set('elementId', specId);
  url.searchParams.set('limit', '100');
  const body = await request(url);
  const workspaces = Array.isArray(body?.workspaces) ? body.workspaces : [];
  if (!workspaces.some((workspace) => workspace?.id === workspaceId)) {
    throw new Error(`specification ${specId} is not in expected workspace ${workspaceId}`);
  }
}

async function fetchSpecification({ role, workspaceId, specId, apiBase, request }) {
  await assertSpecificationWorkspace({ workspaceId, specId, apiBase, request });
  const body = await request(apiUrl(`/specs/${encodeURIComponent(specId)}/definitions`, apiBase));
  const content = typeof body === 'string'
    ? body
    : typeof body?.definition === 'string'
      ? body.definition
      : body && typeof body === 'object' && !Array.isArray(body) && (body.openapi || body.swagger)
        ? JSON.stringify(body, null, 2)
        : undefined;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`${role} specification definition response was empty or unsupported`);
  }
  const normalized = content.endsWith('\n') ? content : `${content}\n`;
  const { document, version } = validateOas(normalized, role);
  return {
    role,
    workspaceId,
    specId,
    content: normalized,
    sha256: createHash('sha256').update(normalized).digest('hex'),
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
  if (!apiKey) throw new Error('POSTMAN_API_KEY is required');
  const request = (url) => requestPostmanJson(url, { apiKey, fetchImpl, sleepImpl });
  const artifacts = await Promise.all([
    fetchSpecification({
      role: 'consumer', workspaceId: inputs.consumerWorkspaceId,
      specId: inputs.consumerSpecId, apiBase, request,
    }),
    fetchSpecification({
      role: 'provider', workspaceId: inputs.providerWorkspaceId,
      specId: inputs.providerSpecId, apiBase, request,
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
    apiBase: new URL(apiBase).origin,
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
    outDir: arg('out-dir', '.contract-inputs/postman'),
    apiKey: process.env.POSTMAN_API_KEY,
    apiBase: process.env.POSTMAN_API_BASE_URL || 'https://api.postman.com',
  });
  for (const artifact of result.artifacts) {
    console.log(`[postman-oas] ${artifact.role} ${artifact.title} -> ${artifact.path} sha256=${artifact.sha256}`);
  }
  console.log(`[postman-oas] provenance -> ${result.manifestPath}`);
}
