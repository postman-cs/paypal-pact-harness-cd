import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = join(ROOT, 'scripts/ledger-sync.mjs');
const BUNDLE = join(ROOT, 'tools/pact-harness/scripts/ledger-sync.mjs');

function run(command, args, cwd = ROOT) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function git(args, cwd) {
  const result = run('git', args, cwd);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('ledger CLI help and incomplete invocations are non-mutating', () => {
  const before = git(['status', '--porcelain'], ROOT);
  for (const script of [SOURCE, BUNDLE]) {
    const help = run(process.execPath, [script, '--help']);
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /--apply is mandatory/);

    const incomplete = run(process.execPath, [script, '--dir', ROOT, '--remote', 'origin', '--branch', 'main', '--message', 'unsafe']);
    assert.equal(incomplete.status, 2);
    assert.match(incomplete.stderr, /--apply is required/);

    const current = run(process.execPath, [
      script,
      '--apply',
      '--dir', ROOT,
      '--remote', 'origin',
      '--branch', 'main',
      '--message', 'unsafe',
    ]);
    assert.equal(current.status, 2);
    assert.match(current.stderr, /dedicated ledger checkout/);
  }
  assert.equal(git(['status', '--porcelain'], ROOT), before);
});

test('ledger CLI rejects a current checkout reached through a symbolic-link ancestor', { skip: process.platform === 'win32' }, () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ledger-ancestor-'));
  const alias = join(temporary, 'alias');
  symlinkSync(dirname(ROOT), alias, 'dir');
  try {
    const result = run(process.execPath, [
      SOURCE,
      '--apply',
      '--dir', join(alias, basename(ROOT)),
      '--remote', 'origin',
      '--branch', 'main',
      '--message', 'unsafe',
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /dedicated ledger checkout/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('ledger CLI commits and pushes only an explicitly targeted dedicated checkout', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'ledger-apply-'));
  const remote = join(temporary, 'remote.git');
  const checkout = join(temporary, 'checkout');
  try {
    git(['init', '--bare', remote], temporary);
    git(['clone', remote, checkout], temporary);
    git(['config', 'user.name', 'Contract Ledger Test'], checkout);
    git(['config', 'user.email', 'contract-ledger@example.test'], checkout);
    writeFileSync(join(checkout, 'ledger.json'), '{"version":1}\n');
    git(['add', 'ledger.json'], checkout);
    git(['commit', '-m', 'seed ledger'], checkout);
    git(['branch', '-M', 'main'], checkout);
    git(['push', '-u', 'origin', 'main'], checkout);

    writeFileSync(join(checkout, 'ledger.json'), '{"version":2}\n');
    const result = run(process.execPath, [
      SOURCE,
      '--apply',
      '--dir', checkout,
      '--remote', 'origin',
      '--branch', 'main',
      '--message', 'test: record contract result',
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ledger pushed/);
    assert.equal(git(['status', '--porcelain'], checkout), '');
    assert.equal(git(['show', 'origin/main:ledger.json'], checkout), '{"version":2}');
    assert.equal(readFileSync(join(checkout, 'ledger.json'), 'utf8'), '{"version":2}\n');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
