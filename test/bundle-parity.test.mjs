import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

function filesBelow(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(root, path) : [path.slice(root.length + 1)];
  }).sort();
}

test('the committed portable runtime matches every security-sensitive source module', () => {
  const pairs = [
    ['scripts/install-pact-cli.mjs', 'tools/pact-harness/scripts/install-pact-cli.mjs'],
    ['src/bdc-verify.mjs', 'tools/pact-harness/src/bdc-verify.mjs'],
    ['src/postman-to-pact.mjs', 'tools/pact-harness/src/postman-to-pact.mjs'],
  ];
  const postmanSource = 'scripts/postman';
  const postmanBundle = 'tools/pact-harness/scripts/postman';
  const sourceFiles = filesBelow(postmanSource);
  const bundleFiles = filesBelow(postmanBundle);
  assert.deepEqual(bundleFiles, sourceFiles, 'portable Postman script file set is stale');
  for (const file of sourceFiles) pairs.push([join(postmanSource, file), join(postmanBundle, file)]);

  for (const [source, bundled] of pairs) {
    assert.deepEqual(readFileSync(bundled), readFileSync(source), `${bundled} is stale`);
  }
});
