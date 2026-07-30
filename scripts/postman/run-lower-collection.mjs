#!/usr/bin/env node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed with exit ${result.status ?? 1}`);
  }
  return result.stdout ?? '';
}

const collection = arg('collection');
const baseUrl = arg('base-url');
const outDir = arg('out-dir', '.contract-reports/postman');
const cloud = has('cloud');
if (!collection || !baseUrl) {
  console.error('usage: run-lower-collection --collection <file-or-id> --base-url <url> [--out-dir dir] [--cloud]');
  process.exit(2);
}
const token = process.env.CONTRACT_DEMO_TOKEN;
if (!token) throw new Error('CONTRACT_DEMO_TOKEN is required');
if (cloud && !process.env.POSTMAN_API_KEY) throw new Error('POSTMAN_API_KEY is required for --cloud');

mkdirSync(outDir, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), 'paypal-postman-env-'));
const environmentPath = join(temporary, 'lower.postman_environment.json');
writeFileSync(environmentPath, `${JSON.stringify({
  name: 'ephemeral-lower-contract-environment',
  values: [
    { key: 'baseUrl', value: baseUrl, enabled: true },
    { key: 'contractToken', value: token, enabled: true, type: 'secret' },
  ],
}, null, 2)}\n`, { mode: 0o600 });
chmodSync(environmentPath, 0o600);

try {
  const version = run('postman', ['--version']).trim();
  writeFileSync(join(outDir, 'postman-cli-version.txt'), `${version}\n`);
  if (cloud) run('postman', ['login', '--with-api-key', process.env.POSTMAN_API_KEY]);
  const output = run('postman', [
    'collection', 'run', collection,
    '--environment', environmentPath,
    '--reporters', 'cli,json,junit',
    '--reporter-json-export', join(outDir, 'postman-run.json'),
    '--reporter-json-omitAllHeadersAndBody',
    '--reporter-junit-export', join(outDir, 'postman-run.xml'),
  ]);
  writeFileSync(join(outDir, 'postman-cli-output.txt'), output);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
