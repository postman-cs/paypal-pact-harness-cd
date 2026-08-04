import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  canonicalCollectionSha256,
  executableCollectionContent,
} from '../scripts/postman/collection-canonical.mjs';
import { runLowerCollection } from '../scripts/postman/run-lower-collection.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function collection() {
  return {
    info: {
      name: 'Orders lower',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [{ name: 'Get order', request: { method: 'GET', url: '{{baseUrl}}/orders/1' } }],
  };
}

function successfulPostman(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === '--version') return { status: 0, stdout: '1.45.0\n', stderr: '' };
    writeFileSync(args[args.indexOf('--reporter-json-export') + 1], JSON.stringify({ run: { failures: [] } }));
    writeFileSync(args[args.indexOf('--reporter-junit-export') + 1], '<testsuites tests="1" failures="0"/>\n');
    return { status: 0, stdout: '1 request passed\n', stderr: '' };
  };
}

function assertOwnerOnlyWhenPosix(path) {
  const mode = statSync(path).mode & 0o777;
  if (process.platform === 'win32') {
    // Windows does not implement POSIX owner/group/other permission bits. Node
    // reports writable evidence files as 0666 even after chmod(0600).
    assert.equal(mode & 0o111, 0, 'evidence files must never be executable');
    return;
  }
  assert.equal(mode, 0o600);
}

test('cloud lower run proves workspace and digest, then executes a sealed local snapshot without secrets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-lower-cloud-'));
  const apiKey = 'PMAK-lower-runner-test';
  const demoToken = 'runtime-bearer-secret';
  const remote = collection();
  remote.info._postman_id = 'server-managed-id';
  remote.info._exporter_id = 'server-managed-exporter';
  const expected = canonicalCollectionSha256(collection());
  const fetchCalls = [];
  const spawnCalls = [];

  const result = await runLowerCollection({
    collection: 'user-orders',
    baseUrl: 'http://127.0.0.1:8080',
    outDir: directory,
    cloud: true,
    workspaceId: 'provider-workspace',
    expectedSha256: expected,
    apiKey,
    demoToken,
    environment: { ...process.env, POSTMAN_API_KEY: apiKey, CONTRACT_DEMO_TOKEN: demoToken, SAFE_SENTINEL: 'kept' },
    fetchImpl: async (input) => {
      const url = new URL(input);
      fetchCalls.push(url);
      if (url.pathname === '/workspaces') return json({ workspaces: [{ id: 'provider-workspace' }] });
      if (url.pathname === '/collections/user-orders') return json({ collection: remote });
      return json({ error: 'not found' }, 404);
    },
    sleepImpl: async () => {},
    spawnImpl: successfulPostman(spawnCalls),
    now: () => new Date('2026-08-04T01:02:03.000Z'),
  });

  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].searchParams.get('elementType'), 'collection');
  assert.equal(fetchCalls[0].searchParams.get('elementId'), 'user-orders');
  assert.equal(result.collection.canonicalSha256, expected);
  assert.equal(result.execution.status, 'pass');
  assert.equal(spawnCalls.length, 2);
  for (const call of spawnCalls) {
    assert.equal(call.options.env.POSTMAN_API_KEY, undefined);
    assert.equal(call.options.env.CONTRACT_DEMO_TOKEN, undefined);
    assert.equal(call.options.env.SAFE_SENTINEL, 'kept');
  }
  const run = spawnCalls[1];
  assert.equal(run.args[0], 'collection');
  assert.equal(run.args[1], 'run');
  assert.equal(run.args[2], join(directory, 'postman-collection.snapshot.json'));
  assert.notEqual(run.args[2], 'user-orders');

  const snapshot = readFileSync(result.snapshotPath, 'utf8');
  assert.equal(createHash('sha256').update(snapshot).digest('hex'), result.collection.snapshotSha256);
  assert.equal(canonicalCollectionSha256(JSON.parse(snapshot)), expected);
  assert.equal(snapshot, executableCollectionContent(collection()));
  assert.equal(JSON.parse(snapshot).item[0].request.url, '{{baseUrl}}/orders/1');
  assert.doesNotMatch(snapshot, /server-managed/);
  assertOwnerOnlyWhenPosix(result.snapshotPath);
  const provenance = JSON.parse(readFileSync(result.provenancePath, 'utf8'));
  assert.equal(provenance.source.workspaceId, 'provider-workspace');
  assert.equal(provenance.source.collectionUid, 'user-orders');
  assert.equal(provenance.credentials.postmanApiKeyForwardedToCli, false);
  assert.equal(provenance.credentials.contractDemoTokenForwardedToCliEnvironment, false);
  assert.doesNotMatch(JSON.stringify(provenance), new RegExp(`${apiKey}|${demoToken}`));
});

test('cloud lower run fails before Postman CLI on workspace or digest mismatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-lower-reject-'));
  const document = collection();
  let spawns = 0;
  const common = {
    collection: 'user-orders',
    baseUrl: 'https://lower.example.test',
    outDir: directory,
    cloud: true,
    workspaceId: 'provider-workspace',
    expectedSha256: canonicalCollectionSha256(document),
    apiKey: 'test-key',
    demoToken: 'demo-token',
    sleepImpl: async () => {},
    spawnImpl: () => { spawns += 1; return { status: 0, stdout: '', stderr: '' }; },
  };

  await assert.rejects(
    runLowerCollection({
      ...common,
      fetchImpl: async (input) => new URL(input).pathname === '/workspaces'
        ? json({ workspaces: [{ id: 'different-workspace' }] })
        : json({ collection: document }),
    }),
    /not in expected workspace/,
  );
  assert.equal(spawns, 0);

  await assert.rejects(
    runLowerCollection({
      ...common,
      expectedSha256: '0'.repeat(64),
      fetchImpl: async (input) => new URL(input).pathname === '/workspaces'
        ? json({ workspaces: [{ id: 'provider-workspace' }] })
        : json({ collection: document }),
    }),
    /canonical SHA-256 mismatch/,
  );
  assert.equal(spawns, 0);
});

test('local lower run also snapshots the collection and strips credentials from every child', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-lower-local-'));
  const source = join(directory, 'source.json');
  const reports = join(directory, 'reports');
  writeFileSync(source, JSON.stringify(collection()));
  const calls = [];
  const result = await runLowerCollection({
    collection: source,
    baseUrl: 'https://lower.example.test/',
    outDir: reports,
    cloud: false,
    apiKey: 'PMAK-unused-local-key',
    demoToken: 'local-demo-secret',
    environment: {
      PATH: process.env.PATH,
      POSTMAN_API_KEY: 'PMAK-unused-local-key',
      CONTRACT_DEMO_TOKEN: 'local-demo-secret',
    },
    fetchImpl: async () => { throw new Error('local mode must not call Postman API'); },
    spawnImpl: successfulPostman(calls),
  });
  assert.equal(result.source.kind, 'local-file');
  assert.equal(result.collection.expectedSha256, null);
  assert.equal(calls[1].args[2], join(reports, 'postman-collection.snapshot.json'));
  assert.ok(calls.every((call) => !('POSTMAN_API_KEY' in call.options.env)));
  assert.ok(calls.every((call) => !('CONTRACT_DEMO_TOKEN' in call.options.env)));
});

test('failed Postman execution leaves redacted provenance evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-lower-fail-'));
  const source = join(directory, 'source.json');
  const reports = join(directory, 'reports');
  writeFileSync(source, JSON.stringify(collection()));
  const secret = 'runtime-failure-secret';
  let call = 0;
  await assert.rejects(
    runLowerCollection({
      collection: source,
      baseUrl: 'https://lower.example.test',
      outDir: reports,
      demoToken: secret,
      environment: { PATH: process.env.PATH, CONTRACT_DEMO_TOKEN: secret },
      spawnImpl: () => {
        call += 1;
        return call === 1
          ? { status: 0, stdout: '1.45.0\n', stderr: '' }
          : { status: 1, stdout: secret, stderr: `failed ${secret}` };
      },
    }),
    /failed with exit 1/,
  );
  const provenance = readFileSync(join(reports, 'postman-collection-provenance.json'), 'utf8');
  assert.equal(JSON.parse(provenance).execution.status, 'fail');
  assert.doesNotMatch(provenance, new RegExp(secret));
});

test('fake reporter leaks are sanitized before JSON, JUnit, and text artifacts are retained', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-reporter-leak-'));
  const source = join(directory, 'source.json');
  const reports = join(directory, 'reports');
  const apiKey = 'PMAK-reporter-leak-test';
  const demoToken = 'demo-reporter-leak-test';
  writeFileSync(source, JSON.stringify(collection()));

  let call = 0;
  const result = await runLowerCollection({
    collection: source,
    baseUrl: 'https://lower.example.test',
    outDir: reports,
    apiKey,
    demoToken,
    environment: { PATH: process.env.PATH, POSTMAN_API_KEY: apiKey, CONTRACT_DEMO_TOKEN: demoToken },
    spawnImpl: (_command, args) => {
      call += 1;
      if (call === 1) return { status: 0, stdout: '1.45.0\n', stderr: '' };
      writeFileSync(
        args[args.indexOf('--reporter-json-export') + 1],
        JSON.stringify({ leakedApiKey: apiKey, leakedDemoToken: demoToken }),
      );
      writeFileSync(
        args[args.indexOf('--reporter-junit-export') + 1],
        `<testsuite name="${apiKey}"><system-out>${demoToken} PMAK-unrelated-leak</system-out></testsuite>\n`,
      );
      return { status: 0, stdout: `ran with ${apiKey} and ${demoToken}\n`, stderr: '' };
    },
  });

  for (const name of ['postman-run.json', 'postman-run.xml', 'postman-cli-output.txt']) {
    const artifact = readFileSync(join(reports, name), 'utf8');
    assert.doesNotMatch(artifact, /PMAK-[A-Za-z0-9_-]+/);
    assert.doesNotMatch(artifact, new RegExp(demoToken));
    assert.match(artifact, /\[REDACTED\]/);
    assertOwnerOnlyWhenPosix(join(reports, name));
  }
  assert.equal(result.execution.reporterArtifacts.length, 3);
  assert.ok(result.execution.reporterArtifacts.every((artifact) => artifact.sanitized));
});
