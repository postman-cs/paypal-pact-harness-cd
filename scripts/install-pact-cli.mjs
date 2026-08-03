#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCK_PATH = join(scriptDirectory, '..', 'pact-cli.lock.json');
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function validatePactCliLock(lock) {
  if (lock?.schemaVersion !== 1) throw new Error('pact-cli lock schemaVersion must be 1');
  if (!/^\d+\.\d+\.\d+$/.test(lock.version ?? '')) throw new Error('pact-cli lock version is invalid');
  if (lock.release !== `v${lock.version}`) throw new Error('pact-cli lock release must match version');
  if (lock.repository !== 'pact-foundation/pact-cli') throw new Error('pact-cli lock repository is not trusted');
  if (!lock.assets || typeof lock.assets !== 'object') throw new Error('pact-cli lock assets are required');
  return lock;
}

export function selectPactCliAsset(lock, { platform = process.platform, arch = process.arch } = {}) {
  validatePactCliLock(lock);
  const key = platform === 'linux' && arch === 'x64' ? 'linux-x64-gnu' : null;
  if (!key || !lock.assets[key]) {
    throw new Error(`Pact CLI is not locked for ${platform}/${arch}; Harness requires Linux/Amd64`);
  }
  const asset = lock.assets[key];
  const url = new URL(asset.url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error(`Pact CLI asset URL is not an approved GitHub release URL: ${asset.url}`);
  }
  if (!url.pathname.startsWith(`/pact-foundation/pact-cli/releases/download/${lock.release}/`)) {
    throw new Error(`Pact CLI asset URL does not match locked release ${lock.release}`);
  }
  if (!/^[a-f0-9]{64}$/.test(asset.sha256 ?? '')) throw new Error('Pact CLI asset sha256 is invalid');
  if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > MAX_DOWNLOAD_BYTES) {
    throw new Error('Pact CLI asset byte count is invalid');
  }
  return { key, ...asset };
}

function assertFinalDownloadUrl(response) {
  if (!response.url) return;
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(finalUrl.hostname)) {
    throw new Error(`Pact CLI download redirected to an untrusted host: ${finalUrl.hostname}`);
  }
}

export async function installPactCli({
  lockPath = DEFAULT_LOCK_PATH,
  output,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
} = {}) {
  if (!output) throw new Error('Pact CLI output path is required');
  const lock = validatePactCliLock(JSON.parse(readFileSync(lockPath, 'utf8')));
  const asset = selectPactCliAsset(lock, { platform, arch });

  try {
    const current = readFileSync(output);
    if (current.length === asset.bytes && sha256(current) === asset.sha256) {
      chmodSync(output, 0o755);
      return { version: lock.version, output, sha256: asset.sha256, reused: true };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const response = await fetchImpl(asset.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Pact CLI download returned HTTP ${response.status}`);
  assertFinalDownloadUrl(response);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Pact CLI download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (content.length !== asset.bytes) {
    throw new Error(`Pact CLI byte count mismatch: expected ${asset.bytes}, received ${content.length}`);
  }
  const actual = sha256(content);
  if (actual !== asset.sha256) {
    throw new Error(`Pact CLI sha256 mismatch: expected ${asset.sha256}, received ${actual}`);
  }

  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.part-${process.pid}`;
  try {
    writeFileSync(temporary, content, { mode: 0o755 });
    if (statSync(temporary).size !== asset.bytes) throw new Error('Pact CLI temporary write was incomplete');
    renameSync(temporary, output);
    chmodSync(output, 0o755);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { version: lock.version, output, sha256: actual, reused: false };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`));
if (isMain) {
  const result = await installPactCli({
    lockPath: arg('lock', DEFAULT_LOCK_PATH),
    output: arg('output', '.pact/bin/pact'),
  });
  console.log(`Pact CLI v${result.version} ${result.reused ? 'verified' : 'installed'} at ${result.output} sha256=${result.sha256}`);
}
