#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const packed = spawnSync('npm', [
  'pack',
  join(root, 'tools', 'pact-harness'),
  '--pack-destination',
  out,
  '--json',
], { encoding: 'utf8' });
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || 'npm pack failed');
const metadata = JSON.parse(packed.stdout);
const filename = metadata[0]?.filename;
if (!filename) throw new Error('npm pack did not report an output filename');
const content = readFileSync(join(out, filename));
const sha256 = createHash('sha256').update(content).digest('hex');
writeFileSync(join(out, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
writeFileSync(join(out, 'release-metadata.json'), `${JSON.stringify({
  schemaVersion: 1,
  filename,
  sha256,
  bytes: content.length,
}, null, 2)}\n`);
console.log(`packaged ${filename} (${content.length} bytes, sha256=${sha256})`);
