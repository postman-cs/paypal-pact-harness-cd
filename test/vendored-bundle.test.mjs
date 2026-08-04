import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bundleDigest, verifyVendoredBundle } from '../scripts/verify-vendored-bundle.mjs';
import { validateVendorTargets } from '../scripts/vendor-pact-harness.mjs';

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pact-vendored-bundle-'));
  const bundle = join(root, 'pact-harness');
  const lock = join(root, 'pact-harness.lock.json');
  cpSync('tools/pact-harness', bundle, { recursive: true });
  const packageDocument = JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8'));
  const digest = bundleDigest(bundle);
  writeFileSync(lock, `${JSON.stringify({
    schemaVersion: 1,
    source: {
      repository: 'github.com/postman-cs/paypal-pact-harness-cd',
      commit: '1'.repeat(40),
    },
    bundle: { name: packageDocument.name, version: packageDocument.version, ...digest },
  }, null, 2)}\n`);
  return { bundle, lock };
}

test('a complete customer-vendored bundle matches its external lock', () => {
  const { bundle, lock } = fixture();
  const result = verifyVendoredBundle({ bundle, lock });
  assert.equal(result.status, 'pass');
  assert.equal(result.source.repository, 'github.com/postman-cs/paypal-pact-harness-cd');
  assert.ok(result.bundle.files > 100);
});

test('a modified or additional downstream file fails the full-bundle digest', () => {
  const first = fixture();
  writeFileSync(
    join(first.bundle, 'vendor', 'postman-cs', 'compare-routes.mjs'),
    'tampered\n',
  );
  assert.throws(
    () => verifyVendoredBundle(first),
    /vendored bundle digest mismatch/,
  );

  const second = fixture();
  writeFileSync(join(second.bundle, 'unexpected.txt'), 'extra\n');
  assert.throws(
    () => verifyVendoredBundle(second),
    /vendored bundle digest mismatch/,
  );
});

test('vendor target, external lock, and verifier must remain distinct trust boundaries', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pact-vendor-targets-'));
  const target = join(root, 'pact-harness');
  const lock = join(root, 'pact-harness.lock.json');
  const verifier = join(root, 'verify-pact-harness.mjs');
  assert.deepEqual(validateVendorTargets({ target, lock, verifier }), {
    targetRoot: target,
    lockPath: lock,
    verifierPath: verifier,
  });
  assert.throws(
    () => validateVendorTargets({ target, lock, verifier: lock }),
    /must be distinct paths/,
  );
  assert.throws(
    () => validateVendorTargets({ target, lock: join(target, 'lock.json'), verifier }),
    /--lock must be outside/,
  );
  assert.throws(
    () => validateVendorTargets({ target, lock, verifier: join(target, 'verify.mjs') }),
    /--verifier must be outside/,
  );
});

test('vendor target cannot equal or contain the harness source', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pact-vendor-source-ancestor-'));
  const source = join(root, 'source', 'checkout');
  mkdirSync(source, { recursive: true });
  const lock = join(root, 'customer', 'pact-harness.lock.json');
  const verifier = join(root, 'customer', 'verify-pact-harness.mjs');
  for (const target of [source, join(root, 'source'), root]) {
    assert.throws(
      () => validateVendorTargets({ target, lock, verifier, source }),
      /must not be the harness source or an ancestor/,
    );
  }
});

test('vendor outputs reject symbolic-link targets and parents', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pact-vendor-symlink-'));
  const realParent = join(root, 'real-parent');
  mkdirSync(realParent);
  const linkedParent = join(root, 'linked-parent');
  symlinkSync(realParent, linkedParent, 'dir');
  assert.throws(
    () => validateVendorTargets({
      target: join(linkedParent, 'pact-harness'),
      lock: join(root, 'pact-harness.lock.json'),
      verifier: join(root, 'verify-pact-harness.mjs'),
    }),
    /symbolic link or symbolic-link parent/,
  );

  const realTarget = join(root, 'real-target');
  mkdirSync(realTarget);
  const linkedTarget = join(root, 'linked-target');
  symlinkSync(realTarget, linkedTarget, 'dir');
  assert.throws(
    () => validateVendorTargets({
      target: linkedTarget,
      lock: join(root, 'second.lock.json'),
      verifier: join(root, 'second-verifier.mjs'),
    }),
    /symbolic link or symbolic-link parent/,
  );
});
