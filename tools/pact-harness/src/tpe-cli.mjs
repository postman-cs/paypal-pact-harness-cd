import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTpeConfig } from './tpe-config.mjs';

const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function runtimePaths() {
  if (statSafe(join(SOURCE_ROOT, 'contract-gate.mjs'))) {
    return {
      root: SOURCE_ROOT,
      cli: join(SOURCE_ROOT, 'pact-harness.mjs'),
      gate: join(SOURCE_ROOT, 'contract-gate.mjs'),
      collector: join(SOURCE_ROOT, 'scripts', 'collect-route-inventories.mjs'),
      postman: join(SOURCE_ROOT, 'scripts', 'postman', 'run-lower-collection.mjs'),
      comparator: join(SOURCE_ROOT, 'vendor', 'postman-cs', 'compare-routes.mjs'),
      lock: join(SOURCE_ROOT, 'postman-cs.lock.json'),
    };
  }
  return {
    root: SOURCE_ROOT,
    cli: join(SOURCE_ROOT, 'tools', 'pact-harness', 'pact-harness.mjs'),
    gate: join(SOURCE_ROOT, 'scripts', 'run-contract-gate.mjs'),
    collector: join(SOURCE_ROOT, 'scripts', 'collect-route-inventories.mjs'),
    postman: join(SOURCE_ROOT, 'scripts', 'postman', 'run-lower-collection.mjs'),
    comparator: join(SOURCE_ROOT, 'tools', 'pact-harness', 'vendor', 'postman-cs', 'compare-routes.mjs'),
    lock: join(SOURCE_ROOT, 'postman-cs.lock.json'),
  };
}

function statSafe(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function parseArgs(argv) {
  const result = { command: 'verify', config: 'paypal-contract-gate.config.json' };
  const remaining = [...argv];
  if (remaining[0] && !remaining[0].startsWith('-')) result.command = remaining.shift();
  for (let index = 0; index < remaining.length; index++) {
    const value = remaining[index];
    if (value === '--config') {
      const next = remaining[++index];
      if (!next || next.startsWith('-')) throw new Error('--config requires a repository-relative JSON file');
      result.config = next;
    } else if (value === '--clean') {
      result.clean = true;
    } else if (value === '--help' || value === '-h') {
      result.command = 'help';
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  return result;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function verifyBundleProvenance(paths = runtimePaths()) {
  const lock = JSON.parse(readFileSync(paths.lock, 'utf8'));
  if (lock.repository !== 'postman-cs/paypal-harness-postman-stages') {
    throw new Error(`unexpected Postman-CS source repository: ${lock.repository}`);
  }
  if (!/^[a-f0-9]{40}$/.test(lock.commit ?? '')) throw new Error('Postman-CS commit pin is not immutable');
  const expected = lock.artifacts?.['compare-routes']?.sha256;
  if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('Postman-CS comparator digest is invalid');
  const actual = sha256(readFileSync(paths.comparator));
  if (actual !== expected) throw new Error(`Postman-CS comparator digest mismatch: expected ${expected}, got ${actual}`);
  return { repository: lock.repository, commit: lock.commit, sha256: actual };
}

function run(command, args, { cwd, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(`[error] ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

function relativeInputs(config) {
  const rel = (entry) => entry ? relative(config.root, entry.absolute) : '';
  return {
    oas: rel(config.provider.oas),
    baseline: rel(config.provider.baseline),
    consumer: rel(config.consumer.contract),
    routes: rel(config.application.routes),
    subset: rel(config.policy.subset),
    contractPolicy: rel(config.policy.contract),
    exceptions: rel(config.policy.exceptions),
    reports: rel(config.reports.directory),
  };
}

function doctor(config, paths = runtimePaths()) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`Node 20+ is required; found ${process.versions.node}`);
  const provenance = verifyBundleProvenance(paths);
  const inputs = relativeInputs(config);
  console.log(`[ok] Node ${process.versions.node}`);
  console.log(`[ok] config ${config.configPath} (environment=${config.environment})`);
  console.log(`[ok] provider ${inputs.oas}`);
  console.log(`[ok] consumer ${inputs.consumer} (${config.consumer.format})`);
  console.log(`[ok] route source ${config.application.actuatorUrl ? 'live Actuator + generated OpenAPI' : inputs.routes}`);
  console.log(`[ok] Postman-CS ${provenance.repository}@${provenance.commit.slice(0, 12)} sha256=${provenance.sha256}`);
  if (config.postman.enabled) {
    const cli = run('postman', ['--version'], { cwd: config.root, quiet: true });
    if (cli !== 0) throw new Error('Postman CLI is enabled but `postman --version` failed');
    if (!process.env.CONTRACT_DEMO_TOKEN) throw new Error('CONTRACT_DEMO_TOKEN is required for the Postman runtime check');
    if (config.postman.cloud && !process.env.POSTMAN_API_KEY) {
      throw new Error('POSTMAN_API_KEY is required when postman.cloud=true');
    }
    console.log(`[ok] Postman CLI runtime check enabled (${config.postman.cloud ? 'Cloud history' : 'local collection'})`);
  } else {
    console.log('[ok] Postman runtime check disabled in this profile');
  }
  console.log('[ready] node paypal-contract-gate.mjs verify');
  return { provenance, inputs };
}

function normalizeConsumer(config, paths, inputs) {
  const output = join(config.reports.directory.absolute, 'consumer.pact.json');
  if (config.consumer.format === 'pact') return inputs.consumer;
  const command = config.consumer.format === 'oas' ? 'oas-to-pact' : 'postman-to-pact';
  const sourceFlag = config.consumer.format === 'oas' ? '--oas' : '--collection';
  const exit = run(process.execPath, [
    paths.cli,
    command,
    sourceFlag,
    inputs.consumer,
    '--provider',
    config.provider.name,
    '--out',
    relative(config.root, output),
  ], { cwd: config.root });
  if (exit !== 0) throw new Error(`consumer normalization failed with exit ${exit}`);
  return relative(config.root, output);
}

function collectLiveRoutes(config, paths, inputs) {
  if (!config.application.actuatorUrl) return {
    authoritative: inputs.routes,
    generated: '',
  };
  const inventoryDir = join(inputs.reports, 'inventory');
  const args = [
    paths.collector,
    '--actuator-url', config.application.actuatorUrl,
    '--openapi-url', config.application.generatedOpenApiUrl,
    '--out-dir', inventoryDir,
  ];
  if (config.application.gatewayInventoryUrl) args.push('--gateway-url', config.application.gatewayInventoryUrl);
  if (config.application.runtimeTrafficUrl) args.push('--traffic-url', config.application.runtimeTrafficUrl);
  const exit = run(process.execPath, args, { cwd: config.root });
  if (exit !== 0) throw new Error(`route inventory collection failed with exit ${exit}`);
  return {
    authoritative: join(inventoryDir, 'actuator-mappings.json'),
    generated: join(inventoryDir, 'generated-openapi.json'),
  };
}

function runContractGate(config, paths, inputs, pact, routes) {
  const args = [
    paths.gate,
    '--oas', inputs.oas,
    '--pact', pact,
    '--routes', routes.authoritative,
    '--subset', inputs.subset,
    '--policy', inputs.contractPolicy,
    '--exceptions', inputs.exceptions,
    '--environment', config.environment,
    '--route-policy', config.policy.route,
    '--report-dir', inputs.reports,
  ];
  if (inputs.baseline) args.push('--baseline', inputs.baseline);
  if (config.application.stripPrefix) args.push('--strip-prefix', config.application.stripPrefix);
  if (config.policy.completeResults) args.push('--complete-results');
  return run(process.execPath, args, { cwd: config.root });
}

function crossCheckGenerated(config, paths, inputs, routes) {
  if (!routes.generated) return 0;
  const args = [
    paths.comparator,
    '--spec', inputs.oas,
    '--routes', routes.generated,
    '--subset', inputs.subset,
    '--exceptions', inputs.exceptions,
    '--policy', config.policy.route,
    '--json-out', join(inputs.reports, 'generated-openapi-route-contract.json'),
    '--junit-out', join(inputs.reports, 'generated-openapi-route-contract.xml'),
  ];
  if (config.application.stripPrefix) args.push('--strip-prefix', config.application.stripPrefix);
  return run(process.execPath, args, { cwd: config.root });
}

function runPostman(config, paths, inputs) {
  if (!config.postman.enabled) return 0;
  const args = [
    paths.postman,
    '--collection', config.postman.collection,
    '--base-url', config.postman.baseUrl,
    '--out-dir', join(inputs.reports, 'postman'),
  ];
  if (config.postman.cloud) args.push('--cloud');
  return run(process.execPath, args, { cwd: config.root });
}

function evidenceFiles(directory, prefix = '') {
  const files = [];
  for (const name of readdirSync(directory)) {
    if (name === 'evidence-manifest.json') continue;
    const absolute = join(directory, name);
    const entry = prefix ? join(prefix, name) : name;
    if (statSync(absolute).isDirectory()) files.push(...evidenceFiles(absolute, entry));
    else if (name.endsWith('.json') || name.endsWith('.xml') || name.endsWith('.txt')) files.push(entry);
  }
  return files.sort();
}

export function sealEvidence(reportDirectory) {
  const files = evidenceFiles(reportDirectory);
  const entries = files.map((file) => {
    const content = readFileSync(join(reportDirectory, file));
    return { file: file.replaceAll('\\', '/'), bytes: content.length, sha256: sha256(content) };
  });
  const manifest = { schemaVersion: 1, files: entries };
  writeFileSync(join(reportDirectory, 'evidence-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function verify(config, paths = runtimePaths(), { clean = false } = {}) {
  const { inputs } = doctor(config, paths);
  if (clean) rmSync(config.reports.directory.absolute, { recursive: true, force: true });
  mkdirSync(config.reports.directory.absolute, { recursive: true });
  const pact = normalizeConsumer(config, paths, inputs);
  const routes = collectLiveRoutes(config, paths, inputs);
  const exits = [
    { name: 'contract gate', code: runContractGate(config, paths, inputs, pact, routes) },
    { name: 'generated OpenAPI cross-check', code: crossCheckGenerated(config, paths, inputs, routes) },
    { name: 'Postman runtime check', code: runPostman(config, paths, inputs) },
  ];
  const manifest = sealEvidence(config.reports.directory.absolute);
  const failures = exits.filter((entry) => entry.code !== 0);
  console.log(`[evidence] ${manifest.files.length} file(s) sealed in ${inputs.reports}/evidence-manifest.json`);
  if (failures.length) {
    console.error(`[FAIL] ${failures.map((entry) => `${entry.name} (exit ${entry.code})`).join(', ')}`);
    return 1;
  }
  console.log(`[PASS] PayPal contract gate (${config.environment})`);
  return 0;
}

function help() {
  console.log(`PayPal TPE contract gate

Usage:
  node paypal-contract-gate.mjs doctor [--config paypal-contract-gate.config.json]
  node paypal-contract-gate.mjs verify [--config paypal-contract-gate.config.json] [--clean]

No npm install is required. Paths in the JSON profile are relative to the
repository root. Runtime credentials must be supplied through environment
variables, never committed to the profile.
`);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.command === 'help') {
      help();
      return 0;
    }
    if (!['doctor', 'verify'].includes(args.command)) throw new Error(`unknown command: ${args.command}`);
    const config = loadTpeConfig(args.config, { root: process.cwd(), env: process.env });
    const exit = args.command === 'doctor' ? (doctor(config), 0) : await verify(config, runtimePaths(), args);
    process.exitCode = exit;
    return exit;
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exitCode = 2;
    return 2;
  }
}
