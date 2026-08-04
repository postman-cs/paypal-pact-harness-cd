#!/usr/bin/env node

import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(`Pact evidence assertion failed: ${message}`);
}

function regularFile(path, label) {
  const target = resolve(String(path ?? ''));
  let metadata;
  try {
    metadata = lstatSync(target);
  } catch {
    fail(`${label} is missing`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  return target;
}

function numericAttribute(attributes, name, fallback) {
  const match = String(attributes).match(new RegExp(`\\b${name}=["'](\\d+)["']`));
  if (!match) {
    if (fallback !== undefined) return fallback;
    fail(`JUnit ${name} count is missing`);
  }
  return Number(match[1]);
}

function junitCounts(xml) {
  const root = xml.match(/<testsuites\b([^>]*)>/i);
  if (root && /\btests=["']\d+["']/.test(root[1])) {
    return {
      total: numericAttribute(root[1], 'tests'),
      failed: numericAttribute(root[1], 'failures', 0),
      errors: numericAttribute(root[1], 'errors', 0),
      skipped: numericAttribute(root[1], 'skipped', 0),
    };
  }

  const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/gi)];
  if (!suites.length) fail('JUnit contains no testsuite');
  return suites.reduce((sum, suite) => ({
    total: sum.total + numericAttribute(suite[1], 'tests'),
    failed: sum.failed + numericAttribute(suite[1], 'failures', 0),
    errors: sum.errors + numericAttribute(suite[1], 'errors', 0),
    skipped: sum.skipped + numericAttribute(suite[1], 'skipped', 0),
  }), { total: 0, failed: 0, errors: 0, skipped: 0 });
}

export function assertProviderVerificationEvidence({ junitPath } = {}) {
  const path = regularFile(junitPath, 'provider verification JUnit');
  const xml = readFileSync(path, 'utf8');
  const counts = junitCounts(xml);
  const successful = counts.total - counts.failed - counts.errors - counts.skipped;
  if (counts.total < 1) fail('provider verification executed zero cases');
  if (counts.failed !== 0 || counts.errors !== 0) {
    fail(`provider verification has ${counts.failed} failure(s) and ${counts.errors} error(s)`);
  }
  if (successful < 1) {
    fail(`provider verification has no successful cases (${counts.skipped}/${counts.total} skipped)`);
  }
  return { ...counts, successful };
}

export function assertCanIDeployEvidence({ jsonPath } = {}) {
  const path = regularFile(jsonPath, 'can-i-deploy JSON');
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('can-i-deploy output is not valid JSON');
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    fail('can-i-deploy output must be an object');
  }
  if (!Array.isArray(evidence.matrix) || evidence.matrix.length < 1) {
    fail('can-i-deploy evaluated an empty dependency matrix');
  }
  const summary = evidence.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    fail('can-i-deploy summary is missing');
  }
  for (const field of ['success', 'failed', 'unknown']) {
    if (!Number.isInteger(summary[field]) || summary[field] < 0) {
      fail(`can-i-deploy summary.${field} must be a non-negative integer`);
    }
  }
  if (summary.deployable !== true) fail('can-i-deploy did not return deployable=true');
  if (summary.success < 1) fail('can-i-deploy has no successful dependency checks');
  if (summary.failed !== 0 || summary.unknown !== 0) {
    fail(`can-i-deploy has ${summary.failed} failed and ${summary.unknown} unknown checks`);
  }
  return {
    matrixEntries: evidence.matrix.length,
    deployable: summary.deployable,
    success: summary.success,
    failed: summary.failed,
    unknown: summary.unknown,
  };
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const mode = process.argv[2];
  let result;
  if (mode === 'provider-verification') {
    result = assertProviderVerificationEvidence({ junitPath: arg('junit') });
  } else if (mode === 'can-i-deploy') {
    result = assertCanIDeployEvidence({ jsonPath: arg('json') });
  } else {
    fail('usage: assert-pact-evidence.mjs provider-verification --junit <file> | can-i-deploy --json <file>');
  }
  console.log(`[pact-evidence] ${mode} PASS ${JSON.stringify(result)}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
