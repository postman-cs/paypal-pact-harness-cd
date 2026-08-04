#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRUSTED_REPOSITORY = 'github.com/postman-cs/paypal-pact-harness-cd';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function fail(message) {
  throw new Error(`source attestation failed: ${message}`);
}

export function canonicalRepository(value) {
  const candidate = String(value ?? '').trim();
  if (!candidate) fail('the checkout has no origin URL');

  let host;
  let pathname;
  const scp = candidate.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !candidate.includes('://')) {
    const username = candidate.includes('@') ? candidate.slice(0, candidate.indexOf('@')) : '';
    if (username && username !== 'git') fail('the checkout origin uses an unsupported SSH identity');
    [, host, pathname] = scp;
  } else {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      fail('the checkout origin is not a supported Git URL');
    }
    if (!['https:', 'ssh:'].includes(url.protocol)) {
      fail('the checkout origin must use HTTPS or SSH');
    }
    if (url.password || (url.protocol === 'https:' && url.username)) {
      fail('the checkout origin must not contain embedded credentials');
    }
    if (url.protocol === 'ssh:' && url.username && url.username !== 'git') {
      fail('the checkout origin uses an unsupported SSH identity');
    }
    host = url.hostname;
    pathname = url.pathname;
  }

  const repository = `${String(host).toLowerCase()}/${String(pathname)
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase()}`;
  if (!/^[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository)) {
    fail('the checkout origin does not identify one repository');
  }
  return repository;
}

function git(workspace, ...args) {
  try {
    return execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail(`git ${args.join(' ')} could not be read`);
  }
}

function gitOptional(workspace, ...args) {
  try {
    return execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is missing or invalid JSON`);
  }
}

function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    fail(`cannot hash ${path}`);
  }
}

export function attest({ workspace, expectedCommit, sourceRepository, output }) {
  const checkout = resolve(workspace);
  const gitOrigin = gitOptional(checkout, 'remote', 'get-url', 'origin');
  const ciCodebase = String(sourceRepository ?? '').trim();
  if (!gitOrigin && !ciCodebase) {
    fail('neither the Git origin nor CI codebase repository identity could be read');
  }
  const actualRepository = canonicalRepository(gitOrigin || ciCodebase);
  if (actualRepository !== TRUSTED_REPOSITORY) {
    fail(`expected ${TRUSTED_REPOSITORY}, received ${actualRepository}`);
  }

  const normalizedExpectedCommit = String(expectedCommit ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(normalizedExpectedCommit)) {
    fail('EXPECTED_SOURCE_COMMIT must be a full Git commit SHA');
  }
  const actualCommit = git(checkout, 'rev-parse', 'HEAD').toLowerCase();
  if (actualCommit !== normalizedExpectedCommit) {
    fail(`expected commit ${normalizedExpectedCommit}, checked out ${actualCommit}`);
  }

  const protectedTreeChanges = git(
    checkout,
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    'postman-cs.lock.json',
    'tools/pact-harness',
    'scripts/ci/attest-harness-source.mjs',
  );
  if (protectedTreeChanges) {
    // Do not include porcelain output: a hostile filename could contain secret material.
    fail('protected harness source differs from the attested commit');
  }

  const rootLock = readJson(resolve(checkout, 'postman-cs.lock.json'), 'root Postman-CS lock');
  const bundleLock = readJson(
    resolve(checkout, 'tools/pact-harness/postman-cs.lock.json'),
    'portable bundle Postman-CS lock',
  );
  const provenance = readJson(
    resolve(checkout, 'tools/pact-harness/vendor/postman-cs/PROVENANCE.json'),
    'portable bundle Postman-CS provenance',
  );
  const bundlePackage = readJson(
    resolve(checkout, 'tools/pact-harness/package.json'),
    'portable bundle package manifest',
  );

  if (JSON.stringify(rootLock) !== JSON.stringify(bundleLock)) {
    fail('portable bundle Postman-CS lock differs from the repository lock');
  }
  const artifact = rootLock.artifacts?.['compare-routes'];
  if (
    rootLock.repository !== 'postman-cs/paypal-harness-postman-stages' ||
    !/^[a-f0-9]{40}$/.test(String(rootLock.commit ?? '')) ||
    !/^[a-f0-9]{64}$/.test(String(artifact?.sha256 ?? ''))
  ) {
    fail('Postman-CS comparator lock is not immutable');
  }
  if (
    provenance.repository !== rootLock.repository ||
    provenance.commit !== rootLock.commit ||
    provenance.path !== artifact.path ||
    provenance.sha256 !== artifact.sha256
  ) {
    fail('portable bundle provenance differs from the repository lock');
  }
  const comparator = resolve(checkout, 'tools/pact-harness/vendor/postman-cs/compare-routes.mjs');
  const comparatorSha256 = sha256(comparator);
  if (comparatorSha256 !== artifact.sha256) {
    fail('vendored Postman-CS comparator digest does not match the lock');
  }
  if (bundlePackage.name !== 'pact-harness-bundle' || !bundlePackage.version) {
    fail('portable bundle package identity is invalid');
  }

  const result = {
    schemaVersion: 1,
    status: 'pass',
    repository: actualRepository,
    repositoryEvidence: gitOrigin ? 'git-origin' : 'ci-codebase',
    commit: actualCommit,
    portableBundle: {
      name: bundlePackage.name,
      version: bundlePackage.version,
    },
    postmanCsComparator: {
      repository: rootLock.repository,
      commit: rootLock.commit,
      path: artifact.path,
      sha256: comparatorSha256,
    },
  };

  if (output) {
    const destination = resolve(checkout, output);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = attest({
      workspace: arg('workspace', process.cwd()),
      expectedCommit: arg('expected-commit', process.env.EXPECTED_SOURCE_COMMIT),
      sourceRepository: arg(
        'source-repository',
        process.env.SOURCE_REPOSITORY_URL ||
          process.env.CI_REPO_LINK ||
          process.env.DRONE_REPO_LINK ||
          process.env.CI_REPO_REMOTE ||
          process.env.DRONE_GIT_HTTP_URL,
      ),
      output: arg('output', '.contract-reports/source-attestation.json'),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
