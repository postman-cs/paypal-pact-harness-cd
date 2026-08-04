import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertCanIDeployEvidence,
  assertProviderVerificationEvidence,
} from '../scripts/ci/assert-pact-evidence.mjs';

function temporary(name, content) {
  const directory = mkdtempSync(join(tmpdir(), 'pact-evidence-'));
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

test('provider verification requires at least one successful non-skipped case', () => {
  const passing = temporary('passing.xml', `<?xml version="1.0"?>
    <testsuites tests="4" failures="0" errors="0" skipped="3">
      <testsuite tests="4" failures="0" skipped="3"/>
    </testsuites>`);
  assert.deepEqual(assertProviderVerificationEvidence({ junitPath: passing }), {
    total: 4, failed: 0, errors: 0, skipped: 3, successful: 1,
  });

  const allSkipped = temporary('all-skipped.xml', `<?xml version="1.0"?>
    <testsuites tests="4" failures="0" errors="0" skipped="4"/>`);
  assert.throws(
    () => assertProviderVerificationEvidence({ junitPath: allSkipped }),
    /no successful cases \(4\/4 skipped\)/,
  );

  const empty = temporary('empty.xml', '<testsuite tests="0" failures="0" skipped="0"/>');
  assert.throws(
    () => assertProviderVerificationEvidence({ junitPath: empty }),
    /executed zero cases/,
  );
});

test('provider verification sums individual suites when the root has no totals', () => {
  const path = temporary('suites.xml', `
    <testsuites>
      <testsuite tests="2" failures="0" errors="0" skipped="1"/>
      <testsuite tests="3" failures="0" errors="0" skipped="2"/>
    </testsuites>`);
  assert.deepEqual(assertProviderVerificationEvidence({ junitPath: path }), {
    total: 5, failed: 0, errors: 0, skipped: 3, successful: 2,
  });
});

test('can-i-deploy requires a nonempty successful dependency matrix', () => {
  const passing = temporary('passing.json', JSON.stringify({
    matrix: [{ consumer: 'checkout', provider: 'orders' }],
    summary: { deployable: true, success: 1, failed: 0, unknown: 0 },
  }));
  assert.deepEqual(assertCanIDeployEvidence({ jsonPath: passing }), {
    matrixEntries: 1, deployable: true, success: 1, failed: 0, unknown: 0,
  });

  const build15FalseGreen = temporary('empty-matrix.json', JSON.stringify({
    matrix: [],
    notices: [{ text: 'There are no missing dependencies', type: 'success' }],
    summary: {
      deployable: true,
      failed: 0,
      reason: 'There are no missing dependencies',
      success: 0,
      unknown: 0,
    },
  }));
  assert.throws(
    () => assertCanIDeployEvidence({ jsonPath: build15FalseGreen }),
    /empty dependency matrix/,
  );
});

test('can-i-deploy rejects unknown, failed, or malformed summaries', () => {
  for (const summary of [
    { deployable: false, success: 1, failed: 1, unknown: 0 },
    { deployable: true, success: 1, failed: 0, unknown: 1 },
    { deployable: true, success: 0, failed: 0, unknown: 0 },
  ]) {
    const path = temporary('bad.json', JSON.stringify({ matrix: [{}], summary }));
    assert.throws(() => assertCanIDeployEvidence({ jsonPath: path }), /Pact evidence assertion failed/);
  }
});
