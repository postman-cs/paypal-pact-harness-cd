#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url, {
  attempts = 6,
  timeoutMs = 10_000,
  headers = {},
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: 'error' });
      if (response.ok) return response;
      last = new Error(`${url} returned HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleepImpl(Math.min(5_000, 250 * (2 ** (attempt - 1))));
  }
  throw new Error(`inventory fetch failed after ${attempts} attempt(s): ${last?.message ?? url}`);
}

export async function collectInventories(sources, {
  outDir,
  attempts,
  timeoutMs,
  headers = {},
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  mkdirSync(outDir, { recursive: true });
  const manifest = { schemaVersion: 1, sources: [] };
  for (const source of sources) {
    if (!source.url) continue;
    const response = await fetchWithRetry(source.url, {
      attempts,
      timeoutMs,
      headers,
      fetchImpl,
      sleepImpl,
    });
    const content = await response.text();
    JSON.parse(content); // inventory sources must be valid JSON, never HTML/login pages
    const filename = `${source.id}.json`;
    writeFileSync(join(outDir, filename), content.endsWith('\n') ? content : `${content}\n`);
    manifest.sources.push({
      ...source,
      file: filename,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
    });
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const outDir = arg('out-dir', '.contract-reports/inventory');
  const token = process.env.INVENTORY_BEARER_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const sources = [
    { id: 'actuator-mappings', kind: 'actuator-mappings', url: arg('actuator-url'), authoritative: true },
    { id: 'generated-openapi', kind: 'generated-openapi', url: arg('openapi-url'), authoritative: false },
    { id: 'gateway-inventory', kind: 'gateway-inventory', url: arg('gateway-url'), authoritative: true },
    { id: 'runtime-traffic', kind: 'runtime-traffic', url: arg('traffic-url'), authoritative: false },
  ];
  const manifest = await collectInventories(sources, {
    outDir,
    attempts: Number(arg('attempts', 12)),
    timeoutMs: Number(arg('timeout-ms', 10_000)),
    headers,
  });
  if (!manifest.sources.some((source) => source.id === 'actuator-mappings')) {
    throw new Error('--actuator-url is required: runtime controller mappings are authoritative');
  }
  if (!manifest.sources.some((source) => source.id === 'generated-openapi')) {
    throw new Error('--openapi-url is required: generated OpenAPI is the secondary inventory');
  }
  console.log(`collected ${manifest.sources.length} route inventory source(s) -> ${outDir}`);
}
