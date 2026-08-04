import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setupWorkspaceSimulation } from '../scripts/postman/setup-workspace-simulation.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function postmanState() {
  const state = { workspaces: [], specs: [], collections: [], calls: [] };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    state.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

    if (url.pathname === '/workspaces' && method === 'GET') return response({ workspaces: state.workspaces, meta: { nextCursor: null } });
    if (url.pathname === '/workspaces' && method === 'POST') {
      const workspace = { id: `workspace-${state.workspaces.length + 1}`, name: body.workspace.name };
      state.workspaces.push(workspace);
      return response({ workspace });
    }
    if (url.pathname === '/specs' && method === 'GET') {
      return response({ specs: state.specs.filter((spec) => spec.workspaceId === url.searchParams.get('workspaceId')), meta: { nextCursor: null } });
    }
    if (url.pathname === '/specs' && method === 'POST') {
      const spec = {
        id: `spec-${state.specs.length + 1}`,
        workspaceId: url.searchParams.get('workspaceId'),
        name: body.name,
        content: body.files[0].content,
        path: body.files[0].path,
      };
      state.specs.push(spec);
      return response(spec, 201);
    }
    const specFiles = url.pathname.match(/^\/specs\/([^/]+)\/files$/);
    if (specFiles && method === 'GET') {
      const spec = state.specs.find((entry) => entry.id === specFiles[1]);
      return response({ files: [{ path: spec.path, type: 'ROOT' }] });
    }
    const specFile = url.pathname.match(/^\/specs\/([^/]+)\/files\/(.+)$/);
    if (specFile && method === 'PATCH') {
      const spec = state.specs.find((entry) => entry.id === specFile[1]);
      spec.content = body.content;
      return response({ path: spec.path, type: 'ROOT' });
    }
    if (url.pathname === '/collections' && method === 'GET') {
      const matches = state.collections.filter((entry) =>
        entry.workspaceId === url.searchParams.get('workspace') &&
        entry.collection.info.name === url.searchParams.get('name'));
      return response({ collections: matches.map((entry) => ({ uid: entry.uid, name: entry.collection.info.name })) });
    }
    if (url.pathname === '/collections' && method === 'POST') {
      const entry = { uid: `user-collection-${state.collections.length + 1}`, workspaceId: url.searchParams.get('workspace'), collection: body.collection };
      state.collections.push(entry);
      return response({ collection: { uid: entry.uid } }, 201);
    }
    const collection = url.pathname.match(/^\/collections\/(.+)$/);
    if (collection && method === 'PUT') {
      const entry = state.collections.find((item) => item.uid === collection[1]);
      entry.collection = body.collection;
      return response({ collection: { uid: entry.uid } });
    }
    return response({ error: 'not found' }, 404);
  };
  return { state, fetchImpl };
}

test('dual-workspace setup creates then idempotently updates the same Postman assets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'postman-workspace-setup-'));
  const outPath = join(directory, 'bindings.json');
  const { state, fetchImpl } = postmanState();
  const first = await setupWorkspaceSimulation({
    rootDir: process.cwd(), outPath, apiKey: 'test-key', apiBase: 'https://postman.test', fetchImpl,
    now: () => new Date('2026-08-03T01:00:00.000Z'),
  });
  const second = await setupWorkspaceSimulation({
    rootDir: process.cwd(), outPath, apiKey: 'test-key', apiBase: 'https://postman.test', fetchImpl,
    now: () => new Date('2026-08-03T02:00:00.000Z'),
  });

  assert.equal(state.workspaces.length, 2);
  assert.equal(state.specs.length, 2);
  assert.equal(state.collections.length, 2);
  assert.deepEqual(first.consumer.workspace, { action: 'created', id: 'workspace-1', name: 'PayPal Pact Simulation - Consumer' });
  assert.equal(second.consumer.workspace.action, 'reused');
  assert.equal(second.consumer.spec.action, 'updated');
  assert.equal(second.consumer.collection.action, 'updated');
  assert.equal(second.consumer.workspace.id, first.consumer.workspace.id);
  assert.equal(second.consumer.spec.id, first.consumer.spec.id);
  assert.equal(second.consumer.collection.uid, first.consumer.collection.uid);
  assert.match(second.consumer.spec.sourceSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(readFileSync(outPath, 'utf8'), /test-key|PMAK-/);
  assert.ok(state.calls.every((call) => call.method !== 'DELETE'));
});

test('dual-workspace setup rejects duplicate exact-name workspaces without mutating Postman', async () => {
  const { state, fetchImpl } = postmanState();
  state.workspaces.push(
    { id: 'duplicate-1', name: 'PayPal Pact Simulation - Consumer' },
    { id: 'duplicate-2', name: 'PayPal Pact Simulation - Consumer' },
  );
  await assert.rejects(
    setupWorkspaceSimulation({ rootDir: process.cwd(), outPath: join(mkdtempSync(join(tmpdir(), 'postman-duplicate-')), 'bindings.json'), apiKey: 'test-key', apiBase: 'https://postman.test', fetchImpl }),
    /multiple Postman workspaces named PayPal Pact Simulation - Consumer/,
  );
  assert.ok(state.calls.every((call) => call.method === 'GET'));
});
