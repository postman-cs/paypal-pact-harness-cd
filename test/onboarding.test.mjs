import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('customer-facing Postman commands use the committed install-free bundle', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const name of ['postman:seed-demo', 'postman:setup', 'postman:inspect', 'postman:verify']) {
    assert.match(pkg.scripts[name], /^node tools\/pact-harness\/scripts\/postman\//, `${name} must use the bundle`);
  }
  assert.equal(pkg.scripts['handoff:doctor'], 'node scripts/tpe/prepare-handoff.mjs --check');
  assert.equal(pkg.scripts['handoff:prepare'], 'node scripts/tpe/prepare-handoff.mjs');
});

test('the documented immutable release still resolves to its reviewed commit', () => {
  const expected = 'b20b8c51f03a0fdca907025e02ee24f2b29d817c';
  const resolved = spawnSync('git', ['rev-parse', '--verify', 'refs/tags/v0.6.1^{commit}'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.stdout.trim(), expected);
  for (const path of ['paypal-contract-gate.mjs', 'harness/contract-gate.broker.pipeline.yaml']) {
    const asset = spawnSync('git', ['cat-file', '-e', `v0.6.1:${path}`], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(asset.status, 0, `${path} must exist in v0.6.1`);
  }
});

test('handoff documentation has no pre-release branch instructions', () => {
  const downstream = readFileSync(join(ROOT, 'docs', 'DOWNSTREAM-ADOPTION.md'), 'utf8');
  const handoff = readFileSync(join(ROOT, 'docs', 'SINGLE-REPOSITORY-HANDOFF.md'), 'utf8');
  assert.doesNotMatch(downstream, /Until PR #1|agent\/consumer-contract-e2e/);
  assert.doesNotMatch(handoff, /Publish a protected release tag/);
  assert.match(downstream, /--branch v0\.6\.1/);
  assert.match(handoff, /protected release `v0\.6\.1`/);
});
