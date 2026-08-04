#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, 'demo-local');
const workspace = mkdtempSync(join(tmpdir(), 'paypal-pact-customer-demo-'));
cpSync(source, workspace, { recursive: true });
const entry = join(root, 'toolkit', 'paypal-contract-gate.mjs');
const config = 'paypal-contract-gate.config.json';

function run(args) {
  const result = spawnSync(process.execPath, [entry, ...args, '--config', config], {
    cwd: workspace,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['verify', '--clean']);
console.log(`\n[EVIDENCE] ${join(workspace, '.contract-reports')}`);
console.log('\n[NEXT] Import demo/harness-pipeline.yaml and demo/harness-input-set.yaml into Harness.');
