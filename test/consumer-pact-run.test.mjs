import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  prepareConsumerPactRun,
  validateConsumerPactRun,
} from '../scripts/ci/consumer-pact-run.mjs';

function pact(interactions = [{ description: 'an executable consumer interaction' }]) {
  return {
    consumer: { name: 'checkout-consumer' },
    provider: { name: 'orders-provider' },
    interactions,
    metadata: { pactSpecification: { version: '3.0.0' } },
  };
}

function temporaryWorkspace() {
  return mkdtempSync(join(tmpdir(), 'consumer-pact-run-'));
}

test('prepare rejects a pre-existing Pact directory so stale files cannot be published', () => {
  const workspace = temporaryWorkspace();
  try {
    mkdirSync(join(workspace, 'pacts'));
    writeFileSync(join(workspace, 'pacts', 'stale.json'), JSON.stringify(pact()));
    assert.throws(
      () => prepareConsumerPactRun({ workspace, directory: 'pacts' }),
      /already exists.*stale Pacts cannot be published/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('validation rejects a no-op consumer command in a fresh run directory', () => {
  const workspace = temporaryWorkspace();
  try {
    prepareConsumerPactRun({ workspace, directory: 'run/pacts' });
    assert.throws(
      () => validateConsumerPactRun({ workspace, directory: 'run/pacts' }),
      /produced no Pact JSON files in the fresh run directory/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('validation rejects a Pact document with zero executable interactions', () => {
  const workspace = temporaryWorkspace();
  try {
    prepareConsumerPactRun({ workspace, directory: 'run/pacts' });
    writeFileSync(join(workspace, 'run', 'pacts', 'empty.json'), JSON.stringify(pact([])));
    assert.throws(
      () => validateConsumerPactRun({ workspace, directory: 'run/pacts' }),
      /contains no executable interactions/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('validation accepts executable Pact files created in the prepared directory', () => {
  const workspace = temporaryWorkspace();
  try {
    prepareConsumerPactRun({ workspace, directory: 'run/pacts' });
    writeFileSync(join(workspace, 'run', 'pacts', 'orders.json'), JSON.stringify(pact()));
    assert.deepEqual(
      validateConsumerPactRun({ workspace, directory: 'run/pacts' }),
      ['orders.json'],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
