#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  cpSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attest, TRUSTED_REPOSITORY } from './ci/attest-harness-source.mjs';
import { bundleDigest } from './verify-vendored-bundle.mjs';

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function requireSafeTarget(path, label) {
  const target = resolve(path);
  if (target === resolve('/') || target === resolve(SOURCE_ROOT) || dirname(target) === target) {
    throw new Error(`${label} resolves to an unsafe target`);
  }
  return target;
}

export function vendorPactHarness({ source = SOURCE_ROOT, target, lock, verifier, expectedCommit }) {
  const sourceRoot = resolve(source);
  const targetRoot = requireSafeTarget(target, '--target');
  const lockPath = requireSafeTarget(lock, '--lock');
  const verifierPath = requireSafeTarget(verifier, '--verifier');
  if (lockPath.startsWith(`${targetRoot}/`) || lockPath.startsWith(`${targetRoot}\\`)) {
    throw new Error('--lock must be outside the vendored bundle so it cannot attest itself');
  }

  const sourceAttestation = attest({
    workspace: sourceRoot,
    expectedCommit,
    output: null,
  });
  const dirty = execFileSync('git', [
    '-C', sourceRoot, 'status', '--porcelain', '--untracked-files=all', '--',
    'tools/pact-harness', 'scripts/verify-vendored-bundle.mjs',
  ], { encoding: 'utf8' }).trim();
  if (dirty) {
    throw new Error('refusing to vendor an uncommitted bundle or verifier; use a clean pinned checkout');
  }
  const temporary = `${targetRoot}.part-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(dirname(targetRoot), { recursive: true });
  cpSync(join(sourceRoot, 'tools', 'pact-harness'), temporary, { recursive: true });

  const packageDocument = JSON.parse(readFileSync(join(temporary, 'package.json'), 'utf8'));
  const digest = bundleDigest(temporary);
  const lockDocument = {
    schemaVersion: 1,
    source: {
      repository: TRUSTED_REPOSITORY,
      commit: sourceAttestation.commit,
    },
    bundle: {
      name: packageDocument.name,
      version: packageDocument.version,
      path: relative(dirname(lockPath), targetRoot).replaceAll('\\', '/'),
      ...digest,
    },
  };

  rmSync(targetRoot, { recursive: true, force: true });
  renameSync(temporary, targetRoot);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(lockDocument, null, 2)}\n`);
  mkdirSync(dirname(verifierPath), { recursive: true });
  cpSync(join(sourceRoot, 'scripts', 'verify-vendored-bundle.mjs'), verifierPath);
  return lockDocument;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const target = arg('target');
    const lock = arg('lock');
    const verifier = arg('verifier');
    const expectedCommit = arg('expected-commit');
    if (!target || !lock || !verifier || !expectedCommit) {
      throw new Error(
        'usage: vendor-pact-harness --target <dir> --lock <file> ' +
        '--verifier <file> --expected-commit <full-sha>',
      );
    }
    const result = vendorPactHarness({
      source: arg('source', SOURCE_ROOT), target, lock, verifier, expectedCommit,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`vendor install failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
