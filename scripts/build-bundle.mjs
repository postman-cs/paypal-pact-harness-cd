#!/usr/bin/env node
// Build tools/pact-harness — a self-contained, install-free, platform-agnostic CLI
// bundle (Decision D13). Any runner executes `node paypal-contract-gate.mjs` with
// NO `npm install` and NO source checkout. Keeps `yaml` by vendoring its node build
// (git-natural, not under node_modules) and rewriting the single
// `import ... from 'yaml'` in the copied load.mjs to a relative path.
//
//   node scripts/build-bundle.mjs

import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { downloadArtifact } from './resolve-postman-cs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// This repo vendors the built bundle at tools/pact-harness (what the pipelines call).
const dist = join(root, 'tools', 'pact-harness');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. the engine + the CI helpers (ledger-sync + the Postman CLI pull wrapper)
cpSync(join(root, 'src'), join(dist, 'src'), { recursive: true });
mkdirSync(join(dist, 'scripts'), { recursive: true });
cpSync(join(root, 'scripts', 'ledger-sync.mjs'), join(dist, 'scripts', 'ledger-sync.mjs'));
cpSync(join(root, 'scripts', 'install-pact-cli.mjs'), join(dist, 'scripts', 'install-pact-cli.mjs'));
cpSync(join(root, 'scripts', 'postman'), join(dist, 'scripts', 'postman'), { recursive: true });
cpSync(join(root, 'scripts', 'collect-route-inventories.mjs'), join(dist, 'scripts', 'collect-route-inventories.mjs'));
cpSync(join(root, 'scripts', 'run-contract-gate.mjs'), join(dist, 'contract-gate.mjs'));
cpSync(join(root, 'pact-cli.lock.json'), join(dist, 'pact-cli.lock.json'));

// 2. vendor the exact Postman-CS comparator into the portable bundle. The lock
//    insists on the production repository, a full commit, and a SHA-256 match.
const postmanCsLock = JSON.parse(readFileSync(join(root, 'postman-cs.lock.json'), 'utf8'));
const postmanCsVendor = join(dist, 'vendor', 'postman-cs');
mkdirSync(postmanCsVendor, { recursive: true });
const comparator = await downloadArtifact({
  lock: postmanCsLock,
  artifactName: 'compare-routes',
  output: join(postmanCsVendor, 'compare-routes.mjs'),
});
writeFileSync(
  join(postmanCsVendor, 'PROVENANCE.json'),
  `${JSON.stringify({
    repository: postmanCsLock.repository,
    commit: postmanCsLock.commit,
    path: comparator.path,
    sha256: comparator.sha256,
  }, null, 2)}\n`,
);
cpSync(join(root, 'postman-cs.lock.json'), join(dist, 'postman-cs.lock.json'));

// 3. vendor yaml (node build only: dist/ + package.json + LICENSE)
const yv = join(dist, 'vendor', 'yaml');
mkdirSync(yv, { recursive: true });
cpSync(join(root, 'node_modules', 'yaml', 'dist'), join(yv, 'dist'), { recursive: true });
cpSync(join(root, 'node_modules', 'yaml', 'package.json'), join(yv, 'package.json'));
cpSync(join(root, 'node_modules', 'yaml', 'LICENSE'), join(yv, 'LICENSE'));

// 4. rewrite the one yaml import in the COPIED load.mjs (originals untouched)
const loadPath = join(dist, 'src', 'lib', 'load.mjs');
const load = readFileSync(loadPath, 'utf8').replace(
  "from 'yaml';",
  "from '../../vendor/yaml/dist/index.js';",
);
if (!load.includes('../../vendor/yaml/dist/index.js')) throw new Error('load.mjs yaml import not rewritten — did the import change?');
writeFileSync(loadPath, load);

// 5. entries + manifest + quick-start example + readme
writeFileSync(
  join(dist, 'pact-harness.mjs'),
  "#!/usr/bin/env node\n// Self-contained entry — no npm install. Runs the pact-harness CLI dispatch.\nimport './src/cli.mjs';\n",
);
writeFileSync(
  join(dist, 'paypal-contract-gate.mjs'),
  "#!/usr/bin/env node\n// PayPal TPE entry — config-driven, install-free, and fail-closed.\nimport { main } from './src/tpe-cli.mjs';\nawait main();\n",
);
mkdirSync(join(dist, 'examples'), { recursive: true });
cpSync(
  join(root, 'paypal-contract-gate.config.json'),
  join(dist, 'examples', 'paypal-contract-gate.config.json'),
);
writeFileSync(
  join(dist, 'package.json'),
  JSON.stringify({
    name: 'pact-harness-bundle',
    version: packageVersion,
    private: true,
    type: 'module',
    bin: {
      'pact-harness': './pact-harness.mjs',
      'paypal-contract-gate': './paypal-contract-gate.mjs',
      'paypal-contract-gate-advanced': './contract-gate.mjs',
    },
  }, null, 2) + '\n',
);
writeFileSync(
  join(dist, 'README.md'),
  [
    '# PayPal contract gate — install-free CLI bundle',
    '',
    'Vendored, platform-agnostic build of the pact-harness CLI (Decision D13). No',
    '`npm install`, no repo checkout, and no runtime network dependency for static',
    'verification. Put the bundle beside a secret-free JSON profile and run:',
    '',
    '```bash',
    'node paypal-contract-gate.mjs doctor --config paypal-contract-gate.config.json',
    'node paypal-contract-gate.mjs verify --config paypal-contract-gate.config.json --clean',
    '```',
    '',
    'The low-level commands remain available for advanced integrations:',
    '',
    '```bash',
    'node contract-gate.mjs --oas provider.json --pact consumer.pact.json \\',
    '  --routes runtime-openapi.json --subset subset.json --policy policy.json \\',
    '  --exceptions exceptions.json --environment lower --complete-results',
    'node pact-harness.mjs record-verification --ledger contracts --oas o.json --pact p.json \\',
    '  --consumer-version $SHA --provider-version $PV',
    'node pact-harness.mjs can-i-deploy --ledger contracts --pacticipant svc --version $SHA --to production',
    'node scripts/ledger-sync.mjs --apply --dir /path/to/dedicated-ledger-checkout ' +
      '--remote origin --branch main --message "record: ..."',
    '```',
    '',
    'Low-level commands: `postman-to-pact · oas-to-pact · oas-audit · oas-diff ·',
    'validate-exceptions · bdc-verify · provider-verify · record-verification ·',
    'record-deployment · can-i-deploy`.',
    '',
    '`vendor/yaml` is ISC-licensed. `vendor/postman-cs/compare-routes.mjs` is pulled',
    'from the exact repository, commit, and digest recorded in its PROVENANCE file.',
    'Rebuild from source with `node scripts/build-bundle.mjs` in the pact-harness repo.',
    '',
  ].join('\n'),
);

console.log('built tools/pact-harness — run: node paypal-contract-gate.mjs doctor');
