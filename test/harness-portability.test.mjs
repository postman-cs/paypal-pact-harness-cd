import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the complete Broker proof uses customer-supplied neutral infrastructure connectors', () => {
  const path = join(ROOT, 'harness', 'contract-gate.broker.pipeline.yaml');
  const pipeline = YAML.parse(readFileSync(path, 'utf8')).pipeline;
  const variables = Object.fromEntries(
    pipeline.variables.map((variable) => [variable.name, variable.value]),
  );

  assert.equal(variables.CONTAINER_REGISTRY_CONNECTOR, '<+input>');
  assert.equal(variables.KUBERNETES_CONNECTOR, '<+input>');
  assert.equal(variables.KUBERNETES_NAMESPACE, '<+input>');

  for (const { step } of pipeline.stages[0].stage.spec.execution.steps) {
    assert.equal(
      step.spec.connectorRef,
      '<+pipeline.variables.CONTAINER_REGISTRY_CONNECTOR>',
      `${step.identifier} must use the shared customer-supplied registry connector`,
    );
  }

  const infrastructure = pipeline.stages[0].stage.spec.infrastructure.spec;
  assert.equal(infrastructure.connectorRef, '<+pipeline.variables.KUBERNETES_CONNECTOR>');
  assert.equal(infrastructure.namespace, '<+pipeline.variables.KUBERNETES_NAMESPACE>');
});

test('the repository contains no infrastructure-provider codename', () => {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim().split(/\r?\n/).filter(Boolean);
  const forbiddenInfrastructureNames = new RegExp(
    ['anchor', 'age|het', 'zner'].join(''),
    'i',
  );
  for (const file of files) {
    assert.doesNotMatch(file, forbiddenInfrastructureNames, `${file} has a forbidden path name`);
    assert.doesNotMatch(
      readFileSync(join(ROOT, file), 'utf8'),
      forbiddenInfrastructureNames,
      `${file} has forbidden content`,
    );
  }
});
