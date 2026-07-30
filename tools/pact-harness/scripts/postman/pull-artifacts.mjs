#!/usr/bin/env node
// CLI-first IO plane (Decision D9): pull the consumer collection and the provider
// OAS via the signed Postman CLI so our pure transformer/verifier consume exactly
// what Postman produces. This wrapper shells to `postman`; it does not reimplement
// Postman. The runner provides a reviewed CLI version (no `curl | sh`).
//
//   node scripts/postman/pull-artifacts.mjs \
//     --collection-uid <uid> --spec-id <id> --out-dir .local
//
// Emits: <out-dir>/collection.json  and  <out-dir>/provider-oas.yaml
//
// Notes:
//  - `postman login` / workspace discovery must already be done by the runner
//    (POSTMAN_API_KEY in env, exactly as the provider-side harness expects).
//  - Collection EXPORT to a file is the one lifecycle op the CLI does not expose
//    cleanly, so it uses the documented public API GET (the same carve-out the
//    harness makes: "raw API only where the CLI has no primitive"). Spec pull uses
//    `postman spec` directly.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`[pull] \`${cmd} ${args.join(' ')}\` failed (status ${r.status}):\n${r.stderr || r.stdout}`);
    process.exit(r.status ?? 1);
  }
  return r.stdout;
}

async function fetchJson(url, apiKey, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        headers: { 'X-Api-Key': apiKey },
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.ok) return response.json();
      lastError = new Error(`Postman API returned HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
  }
  throw new Error(`Postman collection export failed: ${lastError?.message ?? 'unknown error'}`);
}

const outDir = arg('out-dir') || '.local';
const collectionUid = arg('collection-uid');
const specId = arg('spec-id');
mkdirSync(outDir, { recursive: true });

// 1. Provider OAS via the Postman CLI (Spec Hub) — CLI primitive, D9.
if (specId) {
  const specPath = join(outDir, 'provider-oas.yaml');
  // `postman spec pull` writes the spec files; adapt the flags to the installed CLI.
  run('postman', ['spec', 'pull', specId, '--output', specPath]);
  console.log(`[pull] provider OAS -> ${specPath}`);
}

// 2. Consumer collection export — lifecycle carve-out (documented public API GET).
if (collectionUid) {
  const key = process.env.POSTMAN_API_KEY;
  if (!key) { console.error('[pull] POSTMAN_API_KEY required to export the collection'); process.exit(2); }
  const body = await fetchJson(`https://api.getpostman.com/collections/${encodeURIComponent(collectionUid)}`, key);
  const collection = body.collection;
  if (!collection || typeof collection !== 'object') throw new Error('Postman API response did not contain a collection');
  const collectionPath = join(outDir, 'collection.json');
  writeFileSync(collectionPath, JSON.stringify(collection, null, 2) + '\n');
  console.log(`[pull] consumer collection -> ${collectionPath}`);
}
