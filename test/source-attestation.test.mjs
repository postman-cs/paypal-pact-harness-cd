import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'ci', 'attest-harness-source.mjs');

function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function fixture(remote = 'https://github.com/postman-cs/paypal-pact-harness-cd.git') {
  const root = mkdtempSync(join(tmpdir(), 'pact-source-attestation-'));
  const vendor = join(root, 'tools', 'pact-harness', 'vendor', 'postman-cs');
  mkdirSync(vendor, { recursive: true });
  const comparator = Buffer.from('export const comparator = true;\n');
  const digest = createHash('sha256').update(comparator).digest('hex');
  const lock = {
    repository: 'postman-cs/paypal-harness-postman-stages',
    commit: 'b7d6a13144ef250efab5db65dc9358daa802429e',
    artifacts: {
      'compare-routes': {
        path: 'scripts/compare-routes.mjs',
        sha256: digest,
      },
    },
  };
  writeFileSync(join(root, 'postman-cs.lock.json'), JSON.stringify(lock));
  writeFileSync(join(root, 'tools', 'pact-harness', 'postman-cs.lock.json'), JSON.stringify(lock));
  writeFileSync(join(vendor, 'compare-routes.mjs'), comparator);
  writeFileSync(join(vendor, 'PROVENANCE.json'), JSON.stringify({
    repository: lock.repository,
    commit: lock.commit,
    path: lock.artifacts['compare-routes'].path,
    sha256: digest,
  }));
  writeFileSync(join(root, 'tools', 'pact-harness', 'package.json'), JSON.stringify({
    name: 'pact-harness-bundle',
    version: '0.4.0',
  }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'contract-ci@example.invalid');
  git(root, 'config', 'user.name', 'Contract CI');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return { root, commit: git(root, 'rev-parse', 'HEAD'), comparator: join(vendor, 'compare-routes.mjs') };
}

function run(root, expectedCommit) {
  return spawnSync(process.execPath, [SCRIPT, '--workspace', root, '--expected-commit', expectedCommit], {
    encoding: 'utf8',
  });
}

test('source attestation accepts HTTPS and SSH checkouts and emits portable provenance', () => {
  for (const remote of [
    'https://github.com/postman-cs/paypal-pact-harness-cd.git',
    'git@github.com:postman-cs/paypal-pact-harness-cd.git',
  ]) {
    const { root, commit } = fixture(remote);
    const result = run(root, commit);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(join(root, '.contract-reports', 'source-attestation.json')));
    assert.equal(evidence.status, 'pass');
    assert.equal(evidence.repository, 'github.com/postman-cs/paypal-pact-harness-cd');
    assert.equal(evidence.commit, commit);
    assert.equal(evidence.portableBundle.name, 'pact-harness-bundle');
  }
});

test('source attestation rejects a wrong repository without echoing credentials', () => {
  const { root, commit } = fixture('https://token-do-not-log@github.com/paypal/paypal-pact-harness-cd.git');
  const result = run(root, commit);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected github\.com\/postman-cs\/paypal-pact-harness-cd/);
  assert.doesNotMatch(result.stderr, /token-do-not-log/);
});

test('source attestation rejects a different commit and a tampered comparator', () => {
  const first = fixture();
  const wrongCommit = run(first.root, '0'.repeat(40));
  assert.notEqual(wrongCommit.status, 0);
  assert.match(wrongCommit.stderr, /expected commit/);

  const second = fixture();
  writeFileSync(second.comparator, 'tampered\n');
  const tampered = run(second.root, second.commit);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /comparator digest does not match/);
});
