import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canIDeployLedger, applyDeployment,
  buildVerificationRecord, buildDeploymentRecord, buildPactRecord, ledgerPaths, safeSeg,
} from '../src/lib/ledger.mjs';
import {
  readLedger, writeVerificationRecord, writeDeploymentRecord, writePactRecord,
} from '../src/ledger-store.mjs';
import { commitAndPush } from '../src/lib/git-retry.mjs';

// ── pure can-i-deploy ──

const V = (consumer, cv, provider, pv, ok) =>
  buildVerificationRecord({ consumer, consumerVersion: cv, provider, providerVersion: pv, ok, at: 'T' });

const snapshot = {
  verifications: [
    V('checkout', 'c1', 'orders', 'p1', true),
    V('checkout', 'c1', 'orders', 'p2', false), // p2 breaks checkout
    V('reporting', 'r1', 'orders', 'p1', true),
    V('reporting', 'r1', 'orders', 'p2', true),
  ],
  environments: { prod: { checkout: { version: 'c1' }, reporting: { version: 'r1' } } },
};

test('provider deployable when every deployed consumer is verified against the candidate', () => {
  const r = canIDeployLedger(snapshot, { pacticipant: 'orders', version: 'p1', environment: 'prod' });
  assert.equal(r.deployable, true);
  assert.equal(r.partnersConsidered, 2);
});

test('provider blocked when a deployed consumer has a FAILED verification against the candidate', () => {
  const r = canIDeployLedger(snapshot, { pacticipant: 'orders', version: 'p2', environment: 'prod' });
  assert.equal(r.deployable, false);
  assert.ok(r.reasons.some((x) => x.includes('checkout@c1')));
  // reporting is fine at p2 — only checkout blocks
  assert.ok(r.matrix.find((m) => m.partner === 'reporting').ok);
  assert.equal(r.matrix.find((m) => m.partner === 'checkout').ok, false);
});

test('provider blocked when NO verification exists for a deployed consumer version', () => {
  const snap = { verifications: [V('checkout', 'c1', 'orders', 'p1', true)], environments: { prod: { checkout: { version: 'cX' } } } };
  const r = canIDeployLedger(snap, { pacticipant: 'orders', version: 'p1', environment: 'prod' });
  assert.equal(r.deployable, false);
  assert.ok(r.reasons[0].includes('no verification'));
});

test('a partner not deployed in the environment imposes no constraint', () => {
  // deploy the consumer while the provider is not yet in prod -> nothing to break
  const r = canIDeployLedger(snapshot, { pacticipant: 'checkout', version: 'c1', environment: 'staging' });
  assert.equal(r.deployable, true);
  assert.ok(r.matrix.every((m) => m.note));
});

test('a pacticipant with no integrations is trivially deployable', () => {
  const r = canIDeployLedger({ verifications: [], environments: {} }, { pacticipant: 'lonely', version: 'v1', environment: 'prod' });
  assert.equal(r.deployable, true);
  assert.equal(r.partnersConsidered, 0);
});

test('applyDeployment is pure and overwrites the current version', () => {
  const e0 = { prod: { orders: { version: 'p1', at: null } } };
  const e1 = applyDeployment(e0, { environment: 'prod', pacticipant: 'orders', version: 'p2', at: 'T' });
  assert.equal(e0.prod.orders.version, 'p1'); // input untouched
  assert.equal(e1.prod.orders.version, 'p2');
});

test('path builders sanitize unsafe segments', () => {
  assert.equal(safeSeg('feature/x@1'), 'feature_x_1');
  assert.equal(ledgerPaths.environment('prod', 'paypal-orders'), 'environments/prod/paypal-orders.json');
});

// ── fs round-trip: write records, read them back, compute over the snapshot ──

test('fs store round-trips and can-i-deploy matches the in-memory result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pact-ledger-'));
  const pact = { consumer: { name: 'checkout' }, provider: { name: 'orders' }, interactions: [] };
  writePactRecord(dir, buildPactRecord(pact, { consumerVersion: 'c1' }));
  writeVerificationRecord(dir, V('checkout', 'c1', 'orders', 'p1', true));
  writeVerificationRecord(dir, V('checkout', 'c1', 'orders', 'p2', false));
  writeDeploymentRecord(dir, buildDeploymentRecord({ pacticipant: 'checkout', version: 'c1', environment: 'prod', at: 'T' }));

  const snap = readLedger(dir);
  assert.equal(snap.verifications.length, 2);
  assert.equal(snap.environments.prod.checkout.version, 'c1');
  assert.equal(canIDeployLedger(snap, { pacticipant: 'orders', version: 'p1', environment: 'prod' }).deployable, true);
  assert.equal(canIDeployLedger(snap, { pacticipant: 'orders', version: 'p2', environment: 'prod' }).deployable, false);
});

// ── git rebase-retry (injected exec) ──

function fakeExec({ statusOut = ' M verifications/x.json', pushFailures = 0 } = {}) {
  const calls = [];
  let pushes = 0;
  const exec = (cmd, a) => {
    calls.push([cmd, ...a].join(' '));
    if (a[0] === 'status') return statusOut;
    if (a[0] === 'push') { pushes++; if (pushes <= pushFailures) throw new Error('non-fast-forward'); return ''; }
    return '';
  };
  return { exec, calls };
}

test('commitAndPush pushes on the first try when the remote is up to date', () => {
  const f = fakeExec();
  const r = commitAndPush({ exec: f.exec, cwd: '/x', message: 'm', branch: 'main' });
  assert.deepEqual(r, { pushed: true, attempts: 1 });
  assert.ok(f.calls.some((c) => c.startsWith('git commit')));
  assert.ok(!f.calls.some((c) => c.includes('pull --rebase')));
});

test('commitAndPush rebases and retries on a non-fast-forward rejection', () => {
  const f = fakeExec({ pushFailures: 1 });
  const r = commitAndPush({ exec: f.exec, cwd: '/x', message: 'm', branch: 'main' });
  assert.equal(r.pushed, true);
  assert.equal(r.attempts, 2);
  assert.ok(f.calls.some((c) => c.includes('pull --rebase origin main')));
});

test('commitAndPush is a no-op when nothing changed (no commit, no push)', () => {
  const f = fakeExec({ statusOut: '' });
  const r = commitAndPush({ exec: f.exec, cwd: '/x', message: 'm' });
  assert.deepEqual(r, { pushed: false, reason: 'no changes' });
  assert.ok(!f.calls.some((c) => c.startsWith('git commit')));
});

test('commitAndPush throws after exhausting attempts', () => {
  const f = fakeExec({ pushFailures: 99 });
  assert.throws(() => commitAndPush({ exec: f.exec, cwd: '/x', message: 'm', maxAttempts: 3 }), /failed after 3 attempt/);
});
