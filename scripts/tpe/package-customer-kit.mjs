#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PIPELINE_VARIABLES,
  SECRET_IDENTIFIERS,
  renderHarnessInputSet,
  validateHandoffConfig,
  verifyReleaseTag,
} from './prepare-handoff.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SOURCE_REPOSITORY = 'https://github.com/postman-cs/paypal-pact-harness-cd.git';
const MUTATING_TOOL_PATHS = new Set([
  'scripts/postman/setup-workspace-simulation.mjs',
  'scripts/postman/sync-cloud-collection.mjs',
]);
const PRODUCTION_STAGES = [
  'postman-oas-preflight.yaml',
  'pact-consumer-publish.yaml',
  'pact-provider-verify.yaml',
  'consumer-contract-gate.yaml',
  'pact-can-i-deploy.yaml',
  'pact-record-deployment.yaml',
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result.stdout.trim();
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function confinedExistingFile(rootDir, input, label) {
  if (typeof input !== 'string' || !input || isAbsolute(input)) throw new Error(`${label} must be repository-relative`);
  const target = resolve(rootDir, input);
  const rel = relative(rootDir, target);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${label} must resolve inside the repository`);
  }
  if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error(`${label} does not exist: ${input}`);
  const realRel = relative(realpathSync(rootDir), realpathSync(target));
  if (realRel === '..' || realRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realRel)) {
    throw new Error(`${label} resolves outside the repository`);
  }
  return target;
}

function outputTarget(rootDir, input, { force, archive }) {
  if (typeof input !== 'string' || !input || isAbsolute(input)) throw new Error('outDir must be repository-relative');
  const base = resolve(rootDir, '.contract-handoff');
  if (existsSync(base) && lstatSync(base).isSymbolicLink()) throw new Error('.contract-handoff cannot be a symbolic link');
  mkdirSync(base, { recursive: true });
  const realBaseRel = relative(realpathSync(rootDir), realpathSync(base));
  if (realBaseRel === '..' || realBaseRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realBaseRel)) {
    throw new Error('.contract-handoff resolves outside the repository');
  }
  const target = resolve(rootDir, input);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('outDir must be a dedicated directory under .contract-handoff');
  }
  if (existsSync(target) && !force) {
    throw new Error(`${relative(rootDir, target)} already exists; pass --force to replace it`);
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('outDir cannot be a symbolic link');
  if (archive && !force) {
    for (const artifact of [`${target}.tgz`, `${target}.tgz.sha256`]) {
      if (existsSync(artifact)) throw new Error(`${relative(rootDir, artifact)} already exists; pass --force to replace it`);
    }
  }
  return target;
}

function write(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode });
}

function copy(source, destination) {
  if (lstatSync(source).isSymbolicLink()) throw new Error(`refusing to package symbolic link: ${relative(ROOT, source)}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
}

function copyTree(source, destination, prefix = '') {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing to package symbolic link: ${relativeName}`);
    if (MUTATING_TOOL_PATHS.has(relativeName)) continue;
    if (entry.isDirectory()) copyTree(from, to, relativeName);
    else if (entry.isFile()) copy(from, to);
    else throw new Error(`unsupported toolkit entry: ${relativeName}`);
  }
}

function walk(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (name === 'KIT-MANIFEST.json') continue;
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in the kit: ${name}`);
    if (entry.isDirectory()) files.push(...walk(absolute, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`unsupported kit entry: ${name}`);
  }
  return files.sort();
}

function fileInventory(rootDir) {
  return walk(rootDir).map((path) => {
    const content = readFileSync(join(rootDir, path));
    return { path, bytes: content.length, sha256: sha256(content) };
  });
}

function startHere(model) {
  return `# PayPal Pact Harness — start here

This is the customer handoff kit for the Postman-first, consumer-driven contract
testing proof. It is classified as **customer-confidential operational metadata**:
it contains connector names, namespaces, Broker coordinates, and Postman asset
identities, but it contains no credential values.

Release: \`${model.release.sourceRef}\`

Reviewed commit: \`${model.release.reviewedSourceCommit}\`

## 1. Verify the delivery

Requirements: Node.js 20 or newer. No package installation is required.

\`\`\`bash
node verify-kit.mjs
\`\`\`

The verifier rejects missing, added, or changed files; incomplete Harness inputs;
incomplete Postman bindings; credential-shaped values; and cloud-mutating Postman
administration scripts.

## 2. Run the local proof

\`\`\`bash
node run-demo.mjs
\`\`\`

Expected result: \`[PASS] PayPal contract gate (lower)\`. JUnit, JSON, and a sealed
evidence manifest are written only under \`demo-local/.contract-reports/\`.

## 3. Run the complete Harness demonstration

1. Import \`demo/harness-pipeline.yaml\` into Harness project
   \`${model.harness.orgIdentifier}/${model.harness.projectIdentifier}\`.
2. Import \`demo/harness-input-set.yaml\` for pipeline
   \`${model.harness.pipelineIdentifier}\`.
3. Confirm the three secret identifiers in \`demo/required-secrets.md\` exist.
4. Confirm the network routes in \`demo/network-prerequisites.md\`.
5. Execute the Input Set. Use \`demo/expected-first-run.md\` as the acceptance checklist.

The demo uses seeded Orders contract evidence to prove the integration. It does not
represent a PayPal production deployment or a real consumer team's generated Pact.

## 4. Adopt the production lifecycle

Use only the modular templates under \`production/stages/\`. Their exact placement
and ownership boundaries are in \`production/README.md\`. Consumer contract
generation stays in the consumer repository; provider verification stays in the
provider pipeline; deployment recording happens only after deployment and the
target-environment Postman smoke gate succeed.

## Quick failure guide

| Failure | Action |
| --- | --- |
| Integrity or checksum mismatch | Stop; obtain a new kit from the approved release source. |
| Source attestation mismatch | Confirm the Harness build tag and reviewed 40-character commit. |
| Postman identity/digest mismatch | Re-lock the approved workspace asset; do not bypass the check. |
| Empty provider verification | Ensure real pacts and deterministic provider states executed. |
| Empty or unknown \`can-i-deploy\` matrix | Fix Broker publication/verification metadata before promotion. |
| Missing connector/namespace | Update the customer handoff config and regenerate the kit. |
`;
}

function productionReadme(model) {
  return `# Production adoption templates

These are modular stage templates, not one provider-owned mega-pipeline.

## Consumer repository

1. \`postman-oas-preflight.yaml\`
2. \`pact-consumer-publish.yaml\` running the real client tests

The consumer owns and publishes executable Pact output. Do not publish the seeded
demo contract as production evidence.

## Provider pipeline

1. Start the exact candidate provider and deterministic CI-only provider states.
2. \`pact-provider-verify.yaml\`
3. \`consumer-contract-gate.yaml\` for Postman behavior and route evidence.

Provider verification must contain at least one successful, non-skipped case.

## Deployment pipeline

1. \`pact-can-i-deploy.yaml\`
2. Existing customer deployment/promotion stage
3. Target-environment Postman smoke Collection
4. \`pact-record-deployment.yaml\`

Record deployment only after the real deployment and smoke gate succeed. Every
runtime clone must select \`${model.release.sourceRef}\` and independently attest
\`${model.release.reviewedSourceCommit}\`.
`;
}

function requiredSecrets() {
  return `# Required Harness project secrets

Create these identifiers in Harness; never put their values in this kit or an Input Set.

${SECRET_IDENTIFIERS.map((name) => `- \`${name}\``).join('\n')}

Grant the service identities only the lower-environment and read/write permissions
required by their individual stage. Rotate values according to customer policy.
`;
}

function networkPrerequisites(model) {
  return `# Network prerequisites

The selected Harness delegate/runtime needs approved egress to:

- \`github.com/postman-cs/paypal-pact-harness-cd\` for the immutable toolkit checkout;
- \`api.postman.com\` for the workspace-bound OAS and Collection snapshots;
- \`${model.values.BROKER_BASE_URL}\` for the OSS Pact Broker lifecycle;
- the customer container registry selected by \`${model.values.CONTAINER_REGISTRY_CONNECTOR}\`;
- the Kubernetes cluster/namespace selected by \`${model.values.KUBERNETES_CONNECTOR}\` / \`${model.values.KUBERNETES_NAMESPACE}\`;
- the lower provider URL during behavioral and provider-verification stages.

Corporate TLS inspection and private CAs must be configured in the approved runner
or delegate trust store; disabling TLS verification is not supported.
`;
}

function expectedFirstRun(model) {
  return `# First-run acceptance checklist

Accept the demonstration only when all of these are true:

- Source attestation reports \`${model.release.reviewedSourceCommit}\` for \`${model.release.sourceRef}\`.
- Consumer and provider OAS assets match their reviewed Postman workspace identities and digests.
- The approved provider Collection executes at least one request and assertion with zero failures or skips.
- Consumer Pact publication contains at least one executable interaction.
- Provider verification contains at least one successful, non-skipped case and zero failures.
- Broker \`can-i-deploy\` returns a non-empty matrix with at least one success and no failed or unknown rows.
- Every Harness stage, including **Consumer first Broker**, finishes successfully.

The demonstration intentionally performs no PayPal production deployment and does
not call \`record-deployment\`.
`;
}

function distributionNotice() {
  return `# Distribution notice

This kit does not grant a standalone open-source license to Postman-authored code.
Use and distribution are governed by the applicable Postman/customer agreement.
Third-party components and their licenses are listed in
\`THIRD-PARTY-NOTICES.md\` and \`provenance/sbom.cdx.json\`.
`;
}

function sbom(rootDir, model, generatedAt) {
  const project = readJson(join(rootDir, 'package.json'), 'package.json');
  const lock = readJson(join(rootDir, 'package-lock.json'), 'package-lock.json');
  const pactCli = readJson(join(rootDir, 'pact-cli.lock.json'), 'pact-cli.lock.json');
  const comparator = readJson(join(rootDir, 'postman-cs.lock.json'), 'postman-cs.lock.json');
  const yamlVersion = lock.packages?.['node_modules/yaml']?.version ?? 'unknown';
  const pactAsset = pactCli.assets?.['linux-x64-gnu'];
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: generatedAt,
      component: {
        type: 'application',
        name: 'paypal-pact-harness-customer-kit',
        version: project.version,
      },
      properties: [
        { name: 'postman:runtime-release', value: model.release.sourceRef },
        { name: 'postman:runtime-commit', value: model.release.reviewedSourceCommit },
      ],
    },
    components: [
      {
        type: 'library',
        name: 'yaml',
        version: yamlVersion,
        licenses: [{ license: { id: 'ISC' } }],
        purl: `pkg:npm/yaml@${yamlVersion}`,
      },
      {
        type: 'application',
        name: 'pact-cli',
        version: pactCli.version,
        licenses: [{ license: { id: 'MIT' } }],
        hashes: pactAsset ? [{ alg: 'SHA-256', content: pactAsset.sha256 }] : [],
        externalReferences: pactAsset ? [{ type: 'distribution', url: pactAsset.url }] : [],
      },
      {
        type: 'file',
        name: 'postman-cs/compare-routes.mjs',
        version: comparator.commit,
        hashes: [{ alg: 'SHA-256', content: comparator.artifacts['compare-routes'].sha256 }],
        externalReferences: [{ type: 'vcs', url: `https://github.com/${comparator.repository}/commit/${comparator.commit}` }],
      },
    ],
  };
}

function archiveKit(output, { force }) {
  const archive = `${output}.tgz`;
  const checksum = `${archive}.sha256`;
  for (const target of [archive, checksum]) {
    if (existsSync(target)) {
      if (!force) throw new Error(`${relative(ROOT, target)} already exists; pass --force to replace it`);
      rmSync(target, { force: true });
    }
  }
  run('tar', ['-czf', archive, '-C', dirname(output), basename(output)], { cwd: ROOT });
  const content = readFileSync(archive);
  const digest = sha256(content);
  writeFileSync(checksum, `${digest}  ${basename(archive)}\n`, { mode: 0o600 });
  return { archive, checksum, bytes: content.length, sha256: digest };
}

export function packageCustomerKit({
  rootDir = ROOT,
  configPath = '.contract-handoff/config.json',
  outDir,
  force = false,
  archive = true,
  allowDirty = false,
} = {}) {
  const configFile = confinedExistingFile(rootDir, configPath, 'config');
  const model = validateHandoffConfig(readJson(configFile, 'handoff config'), { rootDir });
  verifyReleaseTag(model, { rootDir });
  const project = readJson(join(rootDir, 'package.json'), 'package.json');
  const kitName = `paypal-pact-harness-customer-kit-${model.release.sourceRef}`;
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
  const dirty = Boolean(run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: rootDir }));
  if (dirty && !allowDirty) {
    throw new Error('repository has tracked changes; commit and review them before packaging, or use --allow-dirty for development only');
  }
  const target = outputTarget(rootDir, outDir ?? `.contract-handoff/${kitName}`, { force, archive });
  const output = `${target}.part-${process.pid}`;
  if (existsSync(output)) rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const generatedAt = new Date().toISOString();
  try {
    write(join(output, 'START-HERE.md'), startHere(model));
    copy(join(rootDir, 'scripts/tpe/verify-customer-kit.mjs'), join(output, 'verify-kit.mjs'));
    copy(join(rootDir, 'scripts/tpe/run-customer-demo.mjs'), join(output, 'run-demo.mjs'));
    copy(join(rootDir, 'THIRD-PARTY.md'), join(output, 'THIRD-PARTY-NOTICES.md'));
    write(join(output, 'DISTRIBUTION-NOTICE.md'), distributionNotice());

    copy(join(rootDir, 'harness/contract-gate.broker.pipeline.yaml'), join(output, 'demo/harness-pipeline.yaml'));
    write(join(output, 'demo/harness-input-set.yaml'), renderHarnessInputSet(model));
    write(join(output, 'demo/postman-bindings.json'), `${JSON.stringify(model.binding, null, 2)}\n`);
    write(join(output, 'demo/required-secrets.md'), requiredSecrets());
    write(join(output, 'demo/network-prerequisites.md'), networkPrerequisites(model));
    write(join(output, 'demo/expected-first-run.md'), expectedFirstRun(model));

    write(join(output, 'production/README.md'), productionReadme(model));
    for (const stage of PRODUCTION_STAGES) {
      copy(join(rootDir, 'harness/stages', stage), join(output, 'production/stages', stage));
    }

    copyTree(join(rootDir, 'tools/pact-harness'), join(output, 'toolkit'));
    const demoFiles = [
      'paypal-contract-gate.config.json',
      'fixtures/paypal/checkout_orders_v2.json',
      'fixtures/paypal/orders-consumer.pact.json',
      'fixtures/paypal/orders-spring-routes.json',
      'fixtures/paypal/orders-lower.postman_collection.json',
      'config/subsets/orders-demo.json',
      'config/contract-policy.json',
      'config/route-exceptions.json',
    ];
    for (const file of demoFiles) copy(join(rootDir, file), join(output, 'demo-local', file));

    copy(configFile, join(output, 'provenance/customer-handoff-config.json'));
    copy(join(rootDir, 'pact-cli.lock.json'), join(output, 'provenance/pact-cli.lock.json'));
    copy(join(rootDir, 'postman-cs.lock.json'), join(output, 'provenance/postman-cs.lock.json'));
    write(join(output, 'provenance/sbom.cdx.json'), `${JSON.stringify(sbom(rootDir, model, generatedAt), null, 2)}\n`);
    write(join(output, 'provenance/release.json'), `${JSON.stringify({
      schemaVersion: 1,
      generatedAt,
      sourceRepository: SOURCE_REPOSITORY,
      builderSource: { commit: sourceCommit, dirty },
      runtimeRelease: model.release,
      toolkitVersion: project.version,
      classification: 'customer-confidential operational metadata',
      includedCapability: 'read, attest, pull, verify, publish Pact evidence, and make Broker deployment decisions',
      excludedCapability: 'Postman workspace/specification/Collection create or update administration',
    }, null, 2)}\n`);

    const primary = fileInventory(output);
    write(join(output, 'SHA256SUMS'), primary.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n') + '\n');
    const files = fileInventory(output);
    const manifest = {
      schemaVersion: 1,
      generatedAt,
      classification: 'customer-confidential operational metadata',
      sourceRepository: SOURCE_REPOSITORY,
      builderSource: { commit: sourceCommit, dirty },
      release: model.release,
      toolkitVersion: project.version,
      pipelineIdentifier: model.harness.pipelineIdentifier,
      pipelineVariables: PIPELINE_VARIABLES,
      requiredHarnessSecrets: SECRET_IDENTIFIERS,
      excludedMutatingTools: [...MUTATING_TOOL_PATHS].sort(),
      files,
    };
    write(join(output, 'KIT-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const verify = run(process.execPath, [join(output, 'verify-kit.mjs')], { cwd: output });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(output, target);
    const artifact = archive ? archiveKit(target, { force }) : null;
    console.log(verify);
    console.log(`[ready] customer kit ${relative(rootDir, target)} (${files.length} integrity-checked files)`);
    if (artifact) console.log(`[ready] archive ${relative(rootDir, artifact.archive)} (${artifact.bytes} bytes, sha256=${artifact.sha256})`);
    return { output: target, artifact, manifest };
  } catch (error) {
    if (existsSync(output)) rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function parseArgs(argv) {
  const result = { configPath: '.contract-handoff/config.json', force: false, archive: true, allowDirty: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--config' || value === '--out-dir') {
      const next = argv[++index];
      if (!next || next.startsWith('-')) throw new Error(`${value} requires a repository-relative path`);
      if (value === '--config') result.configPath = next;
      else result.outDir = next;
    } else if (value === '--force') result.force = true;
    else if (value === '--no-archive') result.archive = false;
    else if (value === '--allow-dirty') result.allowDirty = true;
    else if (value === '--help' || value === '-h') result.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function help() {
  console.log(`Build a customer-confidential PayPal Pact Harness delivery kit\n\n` +
    `Usage:\n` +
    `  node scripts/tpe/package-customer-kit.mjs [--config .contract-handoff/config.json] [--force]\n\n` +
    `The config must contain customer-owned Harness, Broker, and Postman bindings.\n` +
    `The resulting folder, .tgz, checksum, SBOM, and full-file manifest are written under .contract-handoff/.\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) help();
    else packageCustomerKit(args);
  } catch (error) {
    console.error(`[FAIL] ${error.message}`);
    process.exitCode = 2;
  }
}
