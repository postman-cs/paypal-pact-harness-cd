#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(`consumer pact output failed: ${message}`);
}

function isInside(parent, candidate) {
  const boundary = relative(parent, candidate);
  return boundary !== '' && boundary !== '..' && !boundary.startsWith(`..${sep}`) && !isAbsolute(boundary);
}

function requestedDirectory(workspace, requested) {
  const root = realpathSync(resolve(workspace));
  const input = String(requested ?? '').trim();
  if (!input || isAbsolute(input)) fail('pacts_path must name a workspace-relative run directory');
  const target = resolve(root, input);
  if (!isInside(root, target)) fail('pacts_path must be a dedicated directory inside the workspace');
  return { root, target };
}

function nearestExisting(path) {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) fail('could not resolve the pacts_path parent');
    candidate = parent;
  }
  return realpathSync(candidate);
}

export function prepareConsumerPactRun({ workspace = process.cwd(), directory } = {}) {
  const { root, target } = requestedDirectory(workspace, directory);
  if (existsSync(target)) {
    fail('pacts_path already exists; supply a fresh run directory so stale Pacts cannot be published');
  }
  const parent = nearestExisting(dirname(target));
  if (parent !== root && !isInside(root, parent)) fail('pacts_path resolves outside the workspace');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const actual = realpathSync(target);
  if (!isInside(root, actual)) fail('pacts_path resolves outside the workspace');
  return actual;
}

export function validateConsumerPactRun({ workspace = process.cwd(), directory } = {}) {
  const { root, target } = requestedDirectory(workspace, directory);
  if (!existsSync(target)) fail('consumer tests produced no Pact output directory');
  const targetStat = lstatSync(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) fail('pacts_path must be a real directory');
  const actualDirectory = realpathSync(target);
  if (!isInside(root, actualDirectory)) fail('pacts_path resolves outside the workspace');

  const entries = readdirSync(actualDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.json'));
  if (!entries.length) fail('consumer tests produced no Pact JSON files in the fresh run directory');

  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) fail(`${entry.name} must be a regular non-symlink Pact file`);
    const path = resolve(actualDirectory, entry.name);
    const actualPath = realpathSync(path);
    if (!isInside(actualDirectory, actualPath)) fail(`${entry.name} resolves outside pacts_path`);
    let pact;
    try {
      pact = JSON.parse(readFileSync(actualPath, 'utf8'));
    } catch {
      fail(`${entry.name} is not valid JSON`);
    }
    if (
      typeof pact?.consumer?.name !== 'string' || !pact.consumer.name.trim() ||
      typeof pact?.provider?.name !== 'string' || !pact.provider.name.trim() ||
      !Array.isArray(pact?.interactions)
    ) {
      fail(`${entry.name} is not a structurally valid Pact document`);
    }
    if (pact.interactions.length === 0) {
      fail(`${entry.name} contains no executable interactions`);
    }
  }
  return entries.map((entry) => entry.name).sort();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const mode = process.argv[2];
    const directory = process.argv[3];
    if (mode === 'prepare') {
      const path = prepareConsumerPactRun({ directory });
      console.log(`[consumer-pacts] prepared fresh output directory ${relative(process.cwd(), path)}`);
    } else if (mode === 'validate') {
      const files = validateConsumerPactRun({ directory });
      console.log(`[consumer-pacts] validated ${files.length} fresh executable Pact file(s)`);
    } else {
      fail('usage: consumer-pact-run.mjs prepare|validate <pacts_path>');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
