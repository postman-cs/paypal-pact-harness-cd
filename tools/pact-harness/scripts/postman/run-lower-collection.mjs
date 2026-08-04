#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  canonicalCollectionSha256,
  executableCollectionContent,
} from './collection-canonical.mjs';
import { postmanApiUrl, redactPostmanSecrets, validatePostmanApiBase } from './postman-api-base.mjs';
import { requestPostmanJson } from './pull-workspace-oas.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{3,200}$/.test(value)) {
    throw new Error(`${label} is required and contains invalid characters`);
  }
  return value;
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.part-${process.pid}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function requestCount(items) {
  return (items ?? []).reduce((total, item) =>
    total + (item?.request ? 1 : 0) + requestCount(item?.item), 0);
}

function validateCollection(collection) {
  if (
    typeof collection?.info?.name !== 'string' ||
    !collection.info.name.trim() ||
    !Array.isArray(collection.item)
  ) {
    throw new Error('Postman collection is empty or malformed');
  }
  const requests = requestCount(collection.item);
  if (requests === 0) throw new Error('Postman collection contains no executable requests');
  return requests;
}

function safeChildEnv(environment) {
  const child = { ...environment };
  delete child.POSTMAN_API_KEY;
  delete child.CONTRACT_DEMO_TOKEN;
  return child;
}

function redact(value, apiKey, demoToken) {
  let text = redactPostmanSecrets(value, apiKey);
  if (demoToken) text = text.split(String(demoToken)).join('[REDACTED]');
  return text;
}

function invoke(command, args, {
  environment,
  apiKey,
  demoToken,
  spawnImpl,
  stream = true,
} = {}) {
  const result = spawnImpl(command, args, {
    encoding: 'utf8',
    env: safeChildEnv(environment),
  });
  if (result.error) throw result.error;
  const rawStdout = result.stdout ?? '';
  const rawStderr = result.stderr ?? '';
  const stdout = redact(rawStdout, apiKey, demoToken);
  const stderr = redact(rawStderr, apiKey, demoToken);
  if (stream && stdout) process.stdout.write(stdout);
  if (stream && stderr) process.stderr.write(stderr);
  return {
    status: result.status,
    stdout,
    stderr,
    stdoutSanitized: stdout !== rawStdout,
    stderrSanitized: stderr !== rawStderr,
  };
}

function run(command, args, options) {
  const result = invoke(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} failed with exit ${result.status ?? 1}`);
  }
  return result.stdout;
}

function containsCredential(value, apiKey, demoToken) {
  const text = String(value ?? '');
  return Boolean(
    (apiKey && text.includes(apiKey)) ||
    (demoToken && text.includes(demoToken)) ||
    /PMAK-[A-Za-z0-9_-]+/.test(text)
  );
}

function sanitizeReporterArtifact(path, {
  apiKey,
  demoToken,
  format,
  required = true,
  alreadySanitized = false,
}) {
  if (!existsSync(path)) {
    if (!required) return null;
    throw new Error(`Postman ${format} reporter did not create ${path}`);
  }
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Postman ${format} reporter artifact is not a regular file`);
    }
    const original = readFileSync(path, 'utf8');
    const sanitized = redact(original, apiKey, demoToken);
    if (containsCredential(sanitized, apiKey, demoToken)) {
      throw new Error(`Postman ${format} reporter artifact still contains a credential after redaction`);
    }
    if (format === 'JSON') JSON.parse(sanitized);
    if (!sanitized.trim()) throw new Error(`Postman ${format} reporter artifact is empty`);
    atomicWrite(path, sanitized);
    const sealed = readFileSync(path, 'utf8');
    if (containsCredential(sealed, apiKey, demoToken)) {
      throw new Error(`Postman ${format} reporter artifact changed before sealing`);
    }
    return {
      path,
      sha256: digest(sealed),
      sanitized: alreadySanitized || sanitized !== original,
    };
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Postman JSON reporter ${label} must be a non-negative integer`);
  }
  return value;
}

function reporterStat(stats, name) {
  const value = stats?.[name];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Postman JSON reporter is missing run.stats.${name}`);
  }
  return {
    total: nonNegativeInteger(value.total, `run.stats.${name}.total`),
    pending: nonNegativeInteger(value.pending ?? 0, `run.stats.${name}.pending`),
    failed: nonNegativeInteger(value.failed ?? 0, `run.stats.${name}.failed`),
  };
}

function xmlInteger(attributes, name) {
  const match = new RegExp(`\\b${name}="(\\d+)"`).exec(attributes);
  return match ? Number(match[1]) : 0;
}

function junitSummary(xml) {
  const root = /<testsuites\b([^>]*)>/i.exec(xml);
  const suites = root ? [root[1]] : [...xml.matchAll(/<testsuite\b([^>]*)>/gi)].map((match) => match[1]);
  if (suites.length === 0) throw new Error('Postman JUnit reporter contains no test suite');
  return suites.reduce((summary, attributes) => ({
    tests: summary.tests + xmlInteger(attributes, 'tests'),
    failures: summary.failures + xmlInteger(attributes, 'failures'),
    errors: summary.errors + xmlInteger(attributes, 'errors'),
    skipped: summary.skipped + xmlInteger(attributes, 'skipped'),
  }), { tests: 0, failures: 0, errors: 0, skipped: 0 });
}

export function assertPostmanExecutionEvidence(jsonPath, junitPath) {
  let json;
  try {
    json = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Postman JSON reporter is invalid: ${error.message}`);
  }
  if (!json?.run || typeof json.run !== 'object' || Array.isArray(json.run)) {
    throw new Error('Postman JSON reporter is missing run evidence');
  }
  // Postman CLI 1.45 omits run.failures on a clean execution and emits an
  // array only when failures exist. Explicit counters plus JUnit below remain
  // the independent, non-vacuous evidence contract.
  if (json.run.failures !== undefined && !Array.isArray(json.run.failures)) {
    throw new Error('Postman JSON reporter run.failures must be an array when present');
  }
  const requests = reporterStat(json.run.stats, 'requests');
  const assertions = reporterStat(json.run.stats, 'assertions');
  if (requests.total === 0) throw new Error('Postman execution ran zero requests');
  if (requests.failed > 0) throw new Error(`Postman execution reported ${requests.failed} failed request(s)`);
  if (requests.pending > 0) throw new Error(`Postman execution reported ${requests.pending} skipped request(s)`);
  if (assertions.total === 0) throw new Error('Postman execution ran zero assertions');
  if (assertions.failed > 0) throw new Error(`Postman execution reported ${assertions.failed} failed assertion(s)`);
  if (assertions.pending > 0) throw new Error(`Postman execution reported ${assertions.pending} skipped assertion(s)`);
  if ((json.run.failures?.length ?? 0) > 0) {
    throw new Error(`Postman execution retained ${json.run.failures.length} failure record(s)`);
  }

  const junit = junitSummary(readFileSync(junitPath, 'utf8'));
  if (junit.tests === 0) throw new Error('Postman JUnit reporter contains zero tests');
  if (junit.failures > 0 || junit.errors > 0 || junit.skipped > 0) {
    throw new Error(
      `Postman JUnit reporter is not clean: failures=${junit.failures}, errors=${junit.errors}, skipped=${junit.skipped}`,
    );
  }
  return { requests, assertions, junit };
}

async function pullCloudCollection({
  uid,
  workspaceId,
  apiKey,
  apiBase,
  fetchImpl,
  sleepImpl,
}) {
  const request = (url) => requestPostmanJson(url, {
    apiKey,
    fetchImpl,
    sleepImpl,
  });
  const membershipUrl = postmanApiUrl('/workspaces', apiBase);
  membershipUrl.searchParams.set('elementType', 'collection');
  membershipUrl.searchParams.set('elementId', uid);
  membershipUrl.searchParams.set('limit', '100');
  const membership = await request(membershipUrl);
  if (!Array.isArray(membership?.workspaces)) {
    throw new Error('Postman collection workspace response is malformed');
  }
  if (!membership.workspaces.some((workspace) => workspace?.id === workspaceId)) {
    throw new Error(`collection ${uid} is not in expected workspace ${workspaceId}`);
  }
  const body = await request(postmanApiUrl(`/collections/${encodeURIComponent(uid)}`, apiBase));
  validateCollection(body?.collection);
  return body.collection;
}

export async function runLowerCollection({
  collection,
  baseUrl,
  outDir = '.contract-reports/postman',
  cloud = false,
  workspaceId,
  expectedSha256,
  apiKey,
  apiBase = 'https://api.postman.com',
  demoToken,
  environment = process.env,
  fetchImpl = fetch,
  sleepImpl,
  spawnImpl = spawnSync,
  now = () => new Date(),
} = {}) {
  if (!collection || typeof collection !== 'string') throw new Error('collection is required');
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error('baseUrl must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new Error('baseUrl must be an absolute http(s) URL without credentials');
  }
  if (!demoToken) throw new Error('CONTRACT_DEMO_TOKEN is required');

  const base = validatePostmanApiBase(apiBase);
  let source;
  let document;
  if (cloud) {
    if (!apiKey) throw new Error('POSTMAN_API_KEY is required for --cloud');
    const uid = requiredId(collection, 'collection UID');
    const expectedWorkspace = requiredId(workspaceId, 'collection workspace ID');
    if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) {
      throw new Error('expected collection SHA-256 is required for --cloud');
    }
    document = await pullCloudCollection({
      uid,
      workspaceId: expectedWorkspace,
      apiKey,
      apiBase: base,
      fetchImpl,
      sleepImpl,
    });
    source = {
      kind: 'postman-cloud',
      collectionUid: uid,
      workspaceId: expectedWorkspace,
      apiBase: base.origin,
    };
  } else {
    document = JSON.parse(readFileSync(collection, 'utf8'));
    source = { kind: 'local-file', path: collection };
    if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error('expected collection SHA-256 must be 64 lowercase hexadecimal characters');
    }
  }

  const requests = validateCollection(document);
  const snapshot = executableCollectionContent(document);
  if (snapshot.includes(apiKey ?? '') && apiKey) {
    throw new Error('collection snapshot contains the Postman API credential');
  }
  if (snapshot.includes(demoToken)) {
    throw new Error('collection snapshot contains the runtime bearer credential');
  }
  const actualSha256 = canonicalCollectionSha256(document);
  const snapshotSha256 = digest(snapshot);
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error(
      `Postman collection canonical SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}`,
    );
  }

  mkdirSync(outDir, { recursive: true });
  const snapshotPath = join(outDir, 'postman-collection.snapshot.json');
  const provenancePath = join(outDir, 'postman-collection-provenance.json');
  const jsonReportPath = join(outDir, 'postman-run.json');
  const junitReportPath = join(outDir, 'postman-run.xml');
  const textReportPath = join(outDir, 'postman-cli-output.txt');
  for (const path of [jsonReportPath, junitReportPath, textReportPath]) {
    rmSync(path, { force: true });
  }
  atomicWrite(snapshotPath, snapshot);
  const sealedSnapshot = readFileSync(snapshotPath);
  if (digest(sealedSnapshot) !== snapshotSha256) {
    throw new Error('Postman collection snapshot changed before execution');
  }
  if (canonicalCollectionSha256(JSON.parse(sealedSnapshot)) !== actualSha256) {
    throw new Error('Postman collection snapshot is not canonically equivalent to the approved source');
  }

  const provenance = {
    schemaVersion: 1,
    retrievedAt: now().toISOString(),
    source,
    collection: {
      name: document.info.name,
      requests,
      expectedSha256: expectedSha256 || null,
      canonicalSha256: actualSha256,
      snapshotSha256,
      bytes: sealedSnapshot.length,
      snapshot: snapshotPath,
    },
    credentials: {
      postmanApiKeyForwardedToCli: false,
      contractDemoTokenForwardedToCliEnvironment: false,
    },
    execution: { status: 'pending' },
  };
  atomicWrite(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  const temporary = mkdtempSync(join(tmpdir(), 'paypal-postman-env-'));
  const environmentPath = join(temporary, 'lower.postman_environment.json');
  writeFileSync(environmentPath, `${JSON.stringify({
    name: 'ephemeral-lower-contract-environment',
    values: [
      { key: 'baseUrl', value: parsedBaseUrl.toString().replace(/\/$/, ''), enabled: true },
      { key: 'contractToken', value: demoToken, enabled: true, type: 'secret' },
    ],
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(environmentPath, 0o600);

  try {
    const version = run('postman', ['--version'], {
      environment, apiKey, demoToken, spawnImpl, stream: false,
    }).trim();
    atomicWrite(join(outDir, 'postman-cli-version.txt'), `${version}\n`);
    const execution = invoke('postman', [
      'collection', 'run', snapshotPath,
      '--environment', environmentPath,
      '--reporters', 'cli,json,junit',
      '--reporter-json-export', jsonReportPath,
      '--reporter-json-omitAllHeadersAndBody',
      '--reporter-junit-export', junitReportPath,
    ], { environment, apiKey, demoToken, spawnImpl });
    atomicWrite(textReportPath, execution.stdout);
    const reporterArtifacts = [];
    let reporterError;
    for (const artifact of [
      { path: textReportPath, format: 'text', required: true },
      { path: jsonReportPath, format: 'JSON', required: execution.status === 0 },
      { path: junitReportPath, format: 'JUnit', required: execution.status === 0 },
    ]) {
      try {
        const sealed = sanitizeReporterArtifact(artifact.path, {
          apiKey,
          demoToken,
          format: artifact.format,
          required: artifact.required,
          alreadySanitized: artifact.path === textReportPath && execution.stdoutSanitized,
        });
        if (sealed) reporterArtifacts.push(sealed);
      } catch (error) {
        reporterError ??= error;
      }
    }
    if (reporterError) throw reporterError;
    if (execution.status !== 0) {
      throw new Error(`postman collection failed with exit ${execution.status ?? 1}`);
    }
    const evidence = assertPostmanExecutionEvidence(jsonReportPath, junitReportPath);
    provenance.execution = {
      status: 'pass',
      postmanCliVersion: version,
      evidence,
      reporterArtifacts,
    };
    atomicWrite(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    return { ...provenance, provenancePath, snapshotPath };
  } catch (error) {
    provenance.execution = {
      status: 'fail',
      error: redact(error?.message ?? error, apiKey, demoToken),
    };
    atomicWrite(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    throw error;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = await runLowerCollection({
    collection: arg('collection'),
    baseUrl: arg('base-url'),
    outDir: arg('out-dir', '.contract-reports/postman'),
    cloud: has('cloud'),
    workspaceId: arg('workspace-id'),
    expectedSha256: arg('expected-sha256'),
    apiKey: process.env.POSTMAN_API_KEY,
    apiBase: process.env.POSTMAN_API_BASE_URL || 'https://api.postman.com',
    demoToken: process.env.CONTRACT_DEMO_TOKEN,
  });
  console.log(`[postman-lower] provenance -> ${result.provenancePath}`);
}
