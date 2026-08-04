import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadArtifact, resolveArtifact, sha256 } from '../scripts/resolve-postman-cs.mjs';

const content = Buffer.from('export const value = 42;\n');
const lock = {
  schemaVersion: 1,
  repository: 'postman-cs/paypal-harness-postman-stages',
  commit: 'b7d6a13144ef250efab5db65dc9358daa802429e',
  artifacts: {
    'compare-routes': {
      path: 'scripts/compare-routes.mjs',
      sha256: sha256(content),
    },
  },
};

test('Postman-CS resolver requires the production repository and a full commit pin', () => {
  const resolved = resolveArtifact(lock, 'compare-routes');
  assert.equal(
    resolved.url,
    'https://raw.githubusercontent.com/postman-cs/paypal-harness-postman-stages/' +
      'b7d6a13144ef250efab5db65dc9358daa802429e/scripts/compare-routes.mjs',
  );
  assert.throws(
    () => resolveArtifact({ ...lock, repository: 'someone/paypal-wrapper' }, 'compare-routes'),
    /directly from postman-cs/,
  );
  assert.throws(
    () => resolveArtifact({ ...lock, commit: 'main' }, 'compare-routes'),
    /full 40-character/,
  );
});

test('Postman-CS resolver verifies the artifact digest before writing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'postman-cs-resolver-'));
  const output = join(dir, 'compare-routes.mjs');
  const fetchImpl = async () => new Response(content, { status: 200 });
  const result = await downloadArtifact({ lock, artifactName: 'compare-routes', output, fetchImpl });
  assert.equal(result.bytes, content.length);
  assert.deepEqual(readFileSync(output), content);
});

test('Postman-CS resolver fails closed on a digest mismatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'postman-cs-resolver-'));
  const output = join(dir, 'compare-routes.mjs');
  const fetchImpl = async () => new Response('tampered\n', { status: 200 });
  await assert.rejects(
    downloadArtifact({ lock, artifactName: 'compare-routes', output, fetchImpl }),
    /digest mismatch/,
  );
});
