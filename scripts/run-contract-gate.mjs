#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; index++; }
  }
  return out;
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function need(args, key) {
  if (typeof args[key] !== 'string' || args[key] === '') throw new Error(`--${key} is required`);
  return args[key];
}

const args = parseArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const bundled = existsSync(join(here, 'pact-harness.mjs'));
const bundleDir = bundled ? here : resolve(here, '../tools/pact-harness');
const cli = typeof args.cli === 'string' ? args.cli : join(bundleDir, 'pact-harness.mjs');
const comparator = typeof args.comparator === 'string'
  ? args.comparator
  : join(bundleDir, 'vendor/postman-cs/compare-routes.mjs');
const reportDir = resolve(args['report-dir'] ?? '.contract-reports');
const complete = args['complete-results'] === true;
mkdirSync(reportDir, { recursive: true });

const tasks = [];
function task(name, command, commandArgs) {
  tasks.push({ name, command, args: commandArgs });
}

const oas = need(args, 'oas');
const pact = need(args, 'pact');
const subset = need(args, 'subset');
const policy = need(args, 'policy');
const environment = args.environment ?? 'lower';
const exceptions = args.exceptions ?? '';

if (exceptions) {
  task('governed-route-exceptions', process.execPath, [
    cli, 'validate-exceptions',
    '--file', exceptions,
    '--environment', environment,
    '--junit', join(reportDir, 'route-exceptions.xml'),
    '--json-out', join(reportDir, 'route-exceptions.json'),
  ]);
}
task('oas-security-examples-negative-audit', process.execPath, [
  cli, 'oas-audit',
  '--oas', oas,
  '--subset', subset,
  '--policy', policy,
  '--junit', join(reportDir, 'oas-audit.xml'),
  '--json-out', join(reportDir, 'oas-audit.json'),
]);
task('consumer-bdc', process.execPath, [
  cli, 'can-i-deploy',
  '--oas', oas,
  '--pact', pact,
  '--policy', policy,
  '--junit', join(reportDir, 'consumer-bdc.xml'),
  '--json-out', join(reportDir, 'consumer-bdc.json'),
]);
if (typeof args.baseline === 'string') {
  task('oas-breaking-diff', process.execPath, [
    cli, 'oas-diff',
    '--baseline', args.baseline,
    '--candidate', oas,
    '--subset', subset,
    '--junit', join(reportDir, 'oas-diff.xml'),
    '--json-out', join(reportDir, 'oas-diff.json'),
  ]);
}
if (typeof args.routes === 'string') {
  const routeArgs = [
    comparator,
    '--spec', oas,
    '--routes', args.routes,
    '--subset', subset,
    '--policy', args['route-policy'] ?? 'block',
    '--json-out', join(reportDir, 'route-contract.json'),
    '--junit-out', join(reportDir, 'route-contract.xml'),
  ];
  if (exceptions) routeArgs.push('--exceptions', exceptions);
  if (typeof args['strip-prefix'] === 'string') routeArgs.push('--strip-prefix', args['strip-prefix']);
  task('route-parity-and-rogue-detection', process.execPath, routeArgs);
}

const results = [];
for (const entry of tasks) {
  if (!complete && results.some((result) => result.status === 'failed')) {
    results.push({ name: entry.name, status: 'skipped', exitCode: null });
    continue;
  }
  console.log(`\n=== ${entry.name} ===`);
  const result = spawnSync(entry.command, entry.args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const exitCode = result.status ?? 1;
  results.push({
    name: entry.name,
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    error: result.error?.message ?? null,
  });
}

const failed = results.filter((result) => result.status === 'failed');
const skipped = results.filter((result) => result.status === 'skipped');
const summary = {
  schemaVersion: 1,
  mode: complete ? 'complete-results' : 'bail',
  environment,
  ok: failed.length === 0,
  counts: {
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: failed.length,
    skipped: skipped.length,
  },
  results,
};
writeFileSync(join(reportDir, 'contract-gate-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const cases = results.map((result) => {
  if (result.status === 'passed') return `    <testcase classname="contract-gate" name="${xml(result.name)}"/>`;
  if (result.status === 'skipped') return `    <testcase classname="contract-gate" name="${xml(result.name)}"><skipped message="bail mode stopped after an earlier failure"/></testcase>`;
  return `    <testcase classname="contract-gate" name="${xml(result.name)}"><failure message="exit ${result.exitCode}">${xml(result.error ?? 'gate failed; see the task-specific JUnit and JSON report')}</failure></testcase>`;
});
writeFileSync(join(reportDir, 'contract-gate-summary.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  `<testsuites name="contract-gate" tests="${results.length}" failures="${failed.length}" skipped="${skipped.length}">`,
  `  <testsuite name="contract-gate" tests="${results.length}" failures="${failed.length}" skipped="${skipped.length}">`,
  ...cases,
  '  </testsuite>',
  '</testsuites>',
  '',
].join('\n'));
console.log(`\ncontract-gate: ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.skipped} skipped (mode=${summary.mode})`);
process.exitCode = summary.ok ? 0 : 1;
