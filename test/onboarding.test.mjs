import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('customer-facing Postman commands use the committed install-free bundle', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const name of ['postman:seed-demo', 'postman:setup', 'postman:inspect', 'postman:verify', 'postman:lock-assets']) {
    assert.match(pkg.scripts[name], /^node tools\/pact-harness\/scripts\/postman\//, `${name} must use the bundle`);
  }
  assert.equal(pkg.scripts['handoff:doctor'], 'node scripts/tpe/prepare-handoff.mjs --check');
  assert.equal(pkg.scripts['handoff:prepare'], 'node scripts/tpe/prepare-handoff.mjs');
});

test('release documentation uses the package version and requires independent commit comparison', () => {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const quickstart = readFileSync(join(ROOT, 'PAYPAL-TPE-QUICKSTART.md'), 'utf8');
  for (const source of [readme, quickstart]) {
    assert.match(source, new RegExp(`--branch v${version.replaceAll('.', '\\.')}\\b`));
    assert.match(source, /compare this full SHA with the Reviewed commit/i);
    assert.doesNotMatch(source, /Immutable source release|protected `v0\./);
  }
});

test('handoff documentation has no pre-release branch instructions', () => {
  const downstream = readFileSync(join(ROOT, 'docs', 'DOWNSTREAM-ADOPTION.md'), 'utf8');
  const handoff = readFileSync(join(ROOT, 'docs', 'SINGLE-REPOSITORY-HANDOFF.md'), 'utf8');
  assert.doesNotMatch(downstream, /Until PR #1|agent\/consumer-contract-e2e/);
  assert.doesNotMatch(handoff, /Publish a protected release tag/);
  assert.match(downstream, /--branch v0\.6\.5/);
  assert.match(handoff, /commit-pinned release `v0\.6\.5`/);
});

test('GitHub release checks fetch versioned tags instead of using a shallow checkout', () => {
  const workflow = YAML.parse(readFileSync(join(ROOT, '.github', 'workflows', 'contract-gate.yml'), 'utf8'));
  const checkouts = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.filter((step) => String(step.uses ?? '').startsWith('actions/checkout@')));
  assert.ok(checkouts.length >= 5, 'every workflow job that uses repository content must be covered');
  for (const checkout of checkouts) {
    assert.equal(checkout.with?.['fetch-depth'], 0, `${checkout.name} must fetch release tags`);
  }
});

test('public Postman evidence uploads exclude raw OAS, Collections, and Pact inputs', () => {
  const source = readFileSync(join(ROOT, '.github', 'workflows', 'contract-gate.yml'), 'utf8');
  const workflow = YAML.parse(source);
  const upload = workflow.jobs['postman-workspace-simulation'].steps
    .find((step) => step.name === 'Upload live Postman workspace evidence');
  assert.ok(upload, 'live Postman evidence upload step must exist');
  const paths = String(upload.with.path).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(paths.sort(), [
    '.contract-reports/postman-workspace-simulation/consumer-collection-bdc.xml',
    '.contract-reports/postman-workspace-simulation/consumer-oas-bdc.xml',
    '.contract-reports/postman-workspace-simulation/evidence.json',
  ].sort());
  assert.doesNotMatch(String(upload.with.path), /inputs|\.pact\.json|postman_collection|\.ya?ml/i);
});
