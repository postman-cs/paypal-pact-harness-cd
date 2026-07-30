#!/usr/bin/env node
// Runnable demo — the whole consumer-driven contract flow with NO box, NO install,
// NO network. Uses the vendored bundle in tools/pact-harness against committed
// fixtures + the seeded git ledger. Operates on a throwaway copy of contracts/ so
// the committed ledger stays pristine.
//
//   node demo/demo.mjs

import { execFileSync } from 'node:child_process';
import { rmSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const B = join(root, 'tools', 'pact-harness', 'pact-harness.mjs');
const tmp = join(root, '.demo-tmp');
const fx = (f) => join(root, 'fixtures', f);

function run(args, allowFail = false) {
  try {
    process.stdout.write(execFileSync('node', [B, ...args], { encoding: 'utf8' }));
    return 0;
  } catch (e) {
    process.stdout.write((e.stdout || '') + (e.stderr || ''));
    if (!allowFail) throw e;
    return e.status || 1;
  }
}

console.log('\n══ PayPal consumer-driven contract gate — GitHub Actions edition ══');
console.log('No broker, no server, no database. Just the bundle + a git ledger.\n');

rmSync(tmp, { recursive: true, force: true });
cpSync(join(root, 'contracts'), tmp, { recursive: true });

console.log('1) Immediate BDC gate — consumer pact × the CURRENT provider OAS:');
run(['bdc-verify', '--oas', fx('orders-oas.json'), '--pact', fx('orders-consumer.pact.json')]);

console.log('\n2) A proposed provider release renames `status`. Record its verification into the ledger:');
run(['record-verification', '--ledger', tmp, '--oas', fx('orders-oas.drift.json'), '--pact', fx('orders-consumer.pact.json'),
  '--consumer-version', '1.0.0', '--provider-version', 'v3-rename-status'], true);

console.log('\n3) can-i-deploy the CURRENT provider (v2-2026-07-01) to production  →  expect YES:');
const a = run(['can-i-deploy', '--ledger', tmp, '--pacticipant', 'paypal-orders', '--version', 'v2-2026-07-01', '--to', 'production'], true);

console.log('\n4) can-i-deploy the PROPOSED provider (v3-rename-status) to production  →  expect NO:');
const b = run(['can-i-deploy', '--ledger', tmp, '--pacticipant', 'paypal-orders', '--version', 'v3-rename-status', '--to', 'production'], true);

rmSync(tmp, { recursive: true, force: true });

console.log(`\n─── ${a === 0 ? 'v2 → YES ✅' : 'v2 → ??'}   ${b !== 0 ? 'v3-rename-status → NO ⛔ (blocked by orders-checkout-consumer)' : 'v3 → ??'} ───`);
console.log('Everything above ran as pure computation over committed files. That is the whole broker.\n');
process.exit(a === 0 && b !== 0 ? 0 : 1);
