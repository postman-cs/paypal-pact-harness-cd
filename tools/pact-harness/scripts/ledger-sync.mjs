#!/usr/bin/env node
// Commit + push the git-backed ledger with rebase-retry (Decision D12) — the
// serialized-write step a pipeline runs after `record-verification` /
// `record-deployment`. Wraps the injectable-exec core in ../src/lib/git-retry.mjs.
//
//   node scripts/ledger-sync.mjs --dir contracts --message "record: ..." [--branch main] [--remote origin]
//
// --dir is the ledger's git working tree. Runs `git add .` within it, so point it
// at a dedicated contracts repo/checkout to keep ledger writes off the app history.

import { execFileSync } from 'node:child_process';
import { commitAndPush } from '../src/lib/git-retry.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else { out[a.slice(2)] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dir = args.dir || '.';
const message = typeof args.message === 'string' ? args.message : 'chore(ledger): record contract results';

// execFileSync returns stdout and throws on non-zero exit — exactly the contract
// commitAndPush expects (throw drives the rebase-retry).
const exec = (cmd, a, opts) =>
  execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

const r = commitAndPush({
  exec,
  cwd: dir,
  message,
  branch: typeof args.branch === 'string' ? args.branch : 'main',
  remote: typeof args.remote === 'string' ? args.remote : 'origin',
});

console.log(r.pushed ? `ledger pushed (attempt ${r.attempts})` : `ledger: ${r.reason}`);
