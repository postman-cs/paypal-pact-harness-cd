#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [relative(root, path)] : [];
  });
}

const files = testFiles(join(root, 'test')).sort();
if (files.length === 0) throw new Error('no test files found');

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
