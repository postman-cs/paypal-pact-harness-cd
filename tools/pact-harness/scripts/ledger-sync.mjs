#!/usr/bin/env node
// Explicit serialized-write helper for a dedicated git-backed contract ledger.
// This command mutates and pushes git state. It has no operational defaults:
// callers must opt in and identify every target on every invocation.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { commitAndPush } from '../src/lib/git-retry.mjs';

function help() {
  console.log(`Commit and push a dedicated git-backed contract ledger\n\n` +
    `Usage:\n` +
    `  node scripts/ledger-sync.mjs --apply --dir <dedicated-checkout> \\\n` +
    `    --remote <remote-name> --branch <branch> --message <commit-message>\n\n` +
    `Safety:\n` +
    `  --apply is mandatory. --dir cannot be the current directory and must be\n` +
    `  the root of its own Git worktree. There are no remote or branch defaults.\n`);
}

function parseArgs(argv) {
  const result = { apply: false, help: false };
  const valued = new Set(['--dir', '--remote', '--branch', '--message']);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--help' || value === '-h') result.help = true;
    else if (value === '--apply') result.apply = true;
    else if (valued.has(value)) {
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value`);
      result[value.slice(2)] = next;
    } else throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function safeName(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value) || value.includes('..')) {
    throw new Error(`${label} is required and must be a safe Git name`);
  }
  return value;
}

function canonicalPath(value) {
  const path = resolve(realpathSync(value));
  return process.platform === 'win32'
    ? path.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase()
    : path;
}

function dedicatedCheckout(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('--dir is required');
  const target = resolve(input);
  const current = canonicalPath(process.cwd());
  if (!existsSync(target) || !lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) {
    throw new Error('--dir must be an existing, non-symbolic-link directory');
  }
  const realTarget = realpathSync(target);
  if (canonicalPath(realTarget) === current) {
    throw new Error('--dir must identify a dedicated ledger checkout, not the current directory');
  }
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: realTarget,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (canonicalPath(top) !== canonicalPath(realTarget)) {
    throw new Error('--dir must be the root of its own dedicated Git worktree');
  }
  return realTarget;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    help();
    return;
  }
  if (!args.apply) throw new Error('--apply is required because this command commits and pushes');
  const cwd = dedicatedCheckout(args.dir);
  const remote = safeName(args.remote, '--remote', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  const branch = safeName(args.branch, '--branch', /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/);
  if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 240 || /[\0\r\n]/.test(args.message)) {
    throw new Error('--message is required, must be one line, and cannot exceed 240 characters');
  }

  const exec = (cmd, commandArgs, options) =>
    execFileSync(cmd, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const result = commitAndPush({ exec, cwd, message: args.message.trim(), branch, remote });
  console.log(result.pushed ? `ledger pushed (attempt ${result.attempts})` : `ledger: ${result.reason}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`[FAIL] ${error.message}`);
  console.error('No ledger changes were requested unless --apply and every explicit target argument were supplied.');
  process.exitCode = 2;
}
