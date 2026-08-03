import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  installPactCli,
  selectPactCliAsset,
  sha256,
  validatePactCliLock,
} from '../scripts/install-pact-cli.mjs';

function lockFor(content, sha = sha256(content)) {
  return {
    schemaVersion: 1,
    version: '9.9.9',
    release: 'v9.9.9',
    repository: 'pact-foundation/pact-cli',
    assets: {
      'linux-x64-gnu': {
        url: 'https://github.com/pact-foundation/pact-cli/releases/download/v9.9.9/pact-x86_64-linux-gnu',
        sha256: sha,
        bytes: content.length,
      },
    },
  };
}

test('the production Pact CLI lock selects an immutable Linux/Amd64 release asset', () => {
  const lock = validatePactCliLock(JSON.parse(readFileSync('pact-cli.lock.json', 'utf8')));
  const asset = selectPactCliAsset(lock, { platform: 'linux', arch: 'x64' });
  assert.equal(lock.version, '0.10.7');
  assert.equal(asset.sha256, '2556840f1e613079b0126e9118a904f48cc1df6914986c45730572ff7ea17a9c');
  assert.match(asset.url, /\/releases\/download\/v0\.10\.7\/pact-x86_64-linux-gnu$/);
  assert.throws(
    () => selectPactCliAsset(lock, { platform: 'linux', arch: 'arm64' }),
    /not locked for linux\/arm64/,
  );
});

test('the Pact CLI installer verifies bytes and digest before making a binary executable', async () => {
  const content = Buffer.from('#!/bin/sh\necho pact-test\n');
  const directory = mkdtempSync(join(tmpdir(), 'pact-cli-install-'));
  const lockPath = join(directory, 'lock.json');
  const output = join(directory, 'bin', 'pact');
  writeFileSync(lockPath, JSON.stringify(lockFor(content)));

  const result = await installPactCli({
    lockPath,
    output,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response(content, {
      status: 200,
      headers: { 'content-length': String(content.length) },
    }),
  });
  assert.equal(result.reused, false);
  assert.deepEqual(readFileSync(output), content);
  assert.notEqual(statSync(output).mode & 0o111, 0);

  const reused = await installPactCli({
    lockPath,
    output,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => { throw new Error('download should not run'); },
  });
  assert.equal(reused.reused, true);
});

test('the Pact CLI installer fails closed on a digest mismatch', async () => {
  const content = Buffer.from('not-the-locked-binary');
  const directory = mkdtempSync(join(tmpdir(), 'pact-cli-corrupt-'));
  const lockPath = join(directory, 'lock.json');
  writeFileSync(lockPath, JSON.stringify(lockFor(content, '0'.repeat(64))));
  await assert.rejects(
    installPactCli({
      lockPath,
      output: join(directory, 'pact'),
      platform: 'linux',
      arch: 'x64',
      fetchImpl: async () => new Response(content, { status: 200 }),
    }),
    /sha256 mismatch/,
  );
});
