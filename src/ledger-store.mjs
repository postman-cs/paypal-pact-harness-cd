// Filesystem projection of the git-backed ledger (Decision D12). The pure model +
// can-i-deploy live in ./lib/ledger.mjs; this module is the only place that touches
// the disk. Node stdlib only. Records are written LF, 2-space JSON, key order fixed
// by the builders — so a committed ledger diffs cleanly and is deterministic.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ledgerPaths } from './lib/ledger.mjs';

function writeJson(dir, rel, obj) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(obj, null, 2) + '\n');
  return rel;
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Read the whole ledger into a snapshot: { verifications, environments }. */
export function readLedger(dir) {
  const verifications = [];
  const vdir = join(dir, 'verifications');
  if (existsSync(vdir)) {
    for (const f of readdirSync(vdir).sort()) {
      if (f.endsWith('.json')) verifications.push(readJson(join(vdir, f)));
    }
  }

  const environments = {};
  const edir = join(dir, 'environments');
  if (existsSync(edir)) {
    for (const env of readdirSync(edir).sort()) {
      const envDir = join(edir, env);
      if (!statSync(envDir).isDirectory()) continue;
      for (const f of readdirSync(envDir).sort()) {
        if (!f.endsWith('.json')) continue;
        const rec = readJson(join(envDir, f));
        (environments[env] ||= {})[rec.pacticipant] = { version: rec.version, at: rec.at ?? null };
      }
    }
  }

  return { verifications, environments };
}

export const writePactRecord = (dir, rec) =>
  writeJson(dir, ledgerPaths.pact(rec.consumer, rec.consumerVersion, rec.provider), rec);
export const writeProviderRecord = (dir, rec) =>
  writeJson(dir, ledgerPaths.provider(rec.provider, rec.providerVersion), rec);
export const writeVerificationRecord = (dir, rec) =>
  writeJson(dir, ledgerPaths.verification(rec.consumer, rec.consumerVersion, rec.provider, rec.providerVersion), rec);
export const writeDeploymentRecord = (dir, rec) =>
  writeJson(dir, ledgerPaths.environment(rec.environment, rec.pacticipant), rec);
