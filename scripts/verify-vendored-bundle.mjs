#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRUSTED_REPOSITORY = 'github.com/postman-cs/paypal-pact-harness-cd';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${label} is missing or invalid JSON: ${path}`);
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function filesBelow(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    .flatMap((entry) => {
      const absolute = join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`vendored bundle may not contain symlinks: ${absolute}`);
      if (stat.isDirectory()) return filesBelow(root, absolute);
      if (!stat.isFile()) throw new Error(`vendored bundle contains an unsupported entry: ${absolute}`);
      return [{
        file: relative(root, absolute).replaceAll('\\', '/'),
        bytes: stat.size,
        sha256: sha256(readFileSync(absolute)),
      }];
    });
}

export function bundleDigest(bundle) {
  const root = resolve(bundle);
  const files = filesBelow(root)
    .sort((a, b) => Buffer.compare(Buffer.from(a.file), Buffer.from(b.file)));
  const folded = new Set();
  for (const entry of files) {
    const components = entry.file.split('/');
    if (
      components.some((component) =>
        !/^[A-Za-z0-9._-]+$/.test(component) ||
        component === '.' ||
        component === '..' ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component))
    ) {
      throw new Error(`vendored bundle contains a non-portable path: ${entry.file}`);
    }
    const key = entry.file.toLowerCase();
    if (folded.has(key)) throw new Error(`vendored bundle contains a case-colliding path: ${entry.file}`);
    folded.add(key);
  }
  const digest = createHash('sha256');
  for (const entry of files) {
    digest.update(entry.file);
    digest.update('\0');
    digest.update(String(entry.bytes));
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\n');
  }
  return { files: files.length, sha256: digest.digest('hex') };
}

export function verifyVendoredBundle({ bundle, lock, output }) {
  const bundleRoot = resolve(bundle);
  const lockDocument = readJson(resolve(lock), 'vendored bundle lock');
  const bundlePackage = readJson(join(bundleRoot, 'package.json'), 'bundle package');

  if (lockDocument.schemaVersion !== 1) throw new Error('vendored bundle lock schemaVersion must be 1');
  if (lockDocument.source?.repository !== TRUSTED_REPOSITORY) {
    throw new Error(`vendored bundle must originate from ${TRUSTED_REPOSITORY}`);
  }
  if (!/^[a-f0-9]{40,64}$/.test(String(lockDocument.source?.commit ?? ''))) {
    throw new Error('vendored bundle source commit must be a full Git SHA');
  }
  if (bundlePackage.name !== 'pact-harness-bundle' || !bundlePackage.version) {
    throw new Error('vendored bundle package identity is invalid');
  }
  if (
    lockDocument.bundle?.name !== bundlePackage.name ||
    lockDocument.bundle?.version !== bundlePackage.version
  ) {
    throw new Error('vendored bundle package does not match its lock');
  }

  const actual = bundleDigest(bundleRoot);
  if (
    actual.files !== lockDocument.bundle.files ||
    actual.sha256 !== lockDocument.bundle.sha256
  ) {
    throw new Error(
      `vendored bundle digest mismatch: expected ${lockDocument.bundle.sha256}, got ${actual.sha256}`,
    );
  }

  const result = {
    schemaVersion: 1,
    status: 'pass',
    source: lockDocument.source,
    bundle: { name: bundlePackage.name, version: bundlePackage.version, ...actual },
  };
  if (output) {
    const destination = resolve(output);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  return result;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const result = verifyVendoredBundle({
      bundle: arg('bundle', '.ci/pact-harness'),
      lock: arg('lock', '.ci/pact-harness.lock.json'),
      output: arg('output', '.contract-inputs/vendored-bundle-attestation.json'),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`vendored bundle attestation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
