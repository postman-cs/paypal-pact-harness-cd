#!/usr/bin/env node
// Build dist/ — a self-contained, install-free, platform-agnostic CLI bundle
// (Decision D13). Any runner executes `node dist/pact-harness.mjs <cmd>` with NO
// `npm install` and NO repo checkout. Keeps `yaml` by vendoring its node build to
// dist/vendor/yaml (git-natural, not under node_modules) and rewriting the single
// `import ... from 'yaml'` in the copied load.mjs to a relative path.
//
//   node scripts/build-bundle.mjs

import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// This repo vendors the built bundle at tools/pact-harness (what the pipelines call).
const dist = join(root, 'tools', 'pact-harness');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. the engine + the CI helpers (ledger-sync + the Postman CLI pull wrapper)
cpSync(join(root, 'src'), join(dist, 'src'), { recursive: true });
mkdirSync(join(dist, 'scripts'), { recursive: true });
cpSync(join(root, 'scripts', 'ledger-sync.mjs'), join(dist, 'scripts', 'ledger-sync.mjs'));
cpSync(join(root, 'scripts', 'postman'), join(dist, 'scripts', 'postman'), { recursive: true });

// 2. vendor yaml (node build only: dist/ + package.json + LICENSE)
const yv = join(dist, 'vendor', 'yaml');
mkdirSync(yv, { recursive: true });
cpSync(join(root, 'node_modules', 'yaml', 'dist'), join(yv, 'dist'), { recursive: true });
cpSync(join(root, 'node_modules', 'yaml', 'package.json'), join(yv, 'package.json'));
cpSync(join(root, 'node_modules', 'yaml', 'LICENSE'), join(yv, 'LICENSE'));

// 3. rewrite the one yaml import in the COPIED load.mjs (originals untouched)
const loadPath = join(dist, 'src', 'lib', 'load.mjs');
const load = readFileSync(loadPath, 'utf8').replace(
  "from 'yaml';",
  "from '../../vendor/yaml/dist/index.js';",
);
if (!load.includes('../../vendor/yaml/dist/index.js')) throw new Error('load.mjs yaml import not rewritten — did the import change?');
writeFileSync(loadPath, load);

// 4. entry + manifest + readme
writeFileSync(
  join(dist, 'pact-harness.mjs'),
  "#!/usr/bin/env node\n// Self-contained entry — no npm install. Runs the pact-harness CLI dispatch.\nimport './src/cli.mjs';\n",
);
writeFileSync(
  join(dist, 'package.json'),
  JSON.stringify({ name: 'pact-harness-bundle', version: '0.1.0', private: true, type: 'module', bin: { 'pact-harness': './pact-harness.mjs' } }, null, 2) + '\n',
);
writeFileSync(
  join(dist, 'README.md'),
  [
    '# pact-harness — install-free CLI bundle',
    '',
    'Vendored, platform-agnostic build of the pact-harness CLI (Decision D13). No',
    '`npm install`, no repo checkout, no network. Drop this folder into any repo/runner',
    'and call it directly:',
    '',
    '```bash',
    'node pact-harness.mjs can-i-deploy --oas provider.json --pact consumer.pact.json',
    'node pact-harness.mjs record-verification --ledger contracts --oas o.json --pact p.json \\',
    '  --consumer-version $SHA --provider-version $PV',
    'node pact-harness.mjs can-i-deploy --ledger contracts --pacticipant svc --version $SHA --to production',
    'node scripts/ledger-sync.mjs --dir contracts --message "record: ..."',
    '```',
    '',
    'Commands: `postman-to-pact · oas-to-pact · bdc-verify · provider-verify ·',
    'record-verification · record-deployment · can-i-deploy`.',
    '',
    'Only third-party code is `vendor/yaml` (MIT) — its licence travels in that folder.',
    'Rebuild from source with `node scripts/build-bundle.mjs` in the pact-harness repo.',
    '',
  ].join('\n'),
);

console.log('built dist/ — run: node dist/pact-harness.mjs <cmd>');
