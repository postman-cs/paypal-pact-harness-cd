#!/usr/bin/env node
// Resolve an executable artifact directly from the production Postman-CS
// repository at a full commit SHA, then verify its locked SHA-256 before use.
// This keeps the customer execution path on postman-cs/* rather than a personal
// wrapper or floating branch.

import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function resolveArtifact(lock, artifactName) {
  if (lock?.schemaVersion !== 1) throw new Error('postman-cs lock schemaVersion must be 1');
  if (lock.repository !== 'postman-cs/paypal-harness-postman-stages') {
    throw new Error('Postman-CS dependency must resolve directly from postman-cs/paypal-harness-postman-stages');
  }
  if (!/^[a-f0-9]{40}$/.test(lock.commit ?? '')) {
    throw new Error('Postman-CS dependency must use a full 40-character commit SHA');
  }
  const artifact = lock.artifacts?.[artifactName];
  if (!artifact) throw new Error(`Unknown Postman-CS artifact: ${artifactName}`);
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) {
    throw new Error(`Postman-CS artifact ${artifactName} must have a SHA-256 digest`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(artifact.path ?? '') || artifact.path.includes('..')) {
    throw new Error(`Postman-CS artifact ${artifactName} has an unsafe path`);
  }
  return {
    ...artifact,
    url: `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${artifact.path}`,
  };
}

export async function downloadArtifact({ lock, artifactName, output, fetchImpl = fetch }) {
  const artifact = resolveArtifact(lock, artifactName);
  const response = await fetchImpl(artifact.url, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(`Postman-CS artifact download failed (${response.status}) from ${artifact.url}`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  const actual = sha256(content);
  if (actual !== artifact.sha256) {
    throw new Error(`Postman-CS artifact digest mismatch: expected ${artifact.sha256}, received ${actual}`);
  }
  writeFileSync(output, content, { mode: 0o755 });
  chmodSync(output, 0o755);
  return { ...artifact, output, bytes: content.length };
}

const isMain = process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const lockPath = arg('lock', 'postman-cs.lock.json');
  const artifactName = arg('artifact');
  const output = arg('out');
  if (!artifactName || !output) {
    console.error('usage: resolve-postman-cs --artifact <name> --out <path> [--lock postman-cs.lock.json]');
    process.exit(2);
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const result = await downloadArtifact({ lock, artifactName, output });
  console.log(
    `resolved ${lock.repository}@${lock.commit}:${result.path} -> ${result.output} ` +
    `(${result.bytes} bytes, sha256=${result.sha256})`,
  );
}
