import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bundleDigest, verifyVendoredBundle } from '../scripts/verify-vendored-bundle.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pact-vendored-bundle-'));
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
