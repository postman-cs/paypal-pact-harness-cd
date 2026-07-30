import { deref, jsonMedia } from './lib/oas.mjs';
import { selectedOperations } from './lib/subset.mjs';
import { validateSchemaValue } from './lib/schema-validate.mjs';

function exampleValues(media, schema) {
  const values = [];
  if (media?.example !== undefined) values.push({ name: 'example', value: media.example });
  for (const [name, raw] of Object.entries(media?.examples ?? {})) {
    const example = raw?.$ref ? null : raw;
    if (example?.value !== undefined) values.push({ name, value: example.value });
  }
  if (schema?.example !== undefined) values.push({ name: 'schema.example', value: schema.example });
  return values;
}

function securityFailures(oas, operation, policy) {
  if (policy.requireSecurity !== true) return [];
  const requirements = operation.security ?? oas.security;
  if (!Array.isArray(requirements) || requirements.length === 0) {
    return [{ check: 'security-missing', detail: 'operation has no effective security requirement' }];
  }
  const schemes = oas.components?.securitySchemes ?? {};
  const failures = [];
  for (const alternative of requirements) {
    for (const [name, scopes] of Object.entries(alternative ?? {})) {
      const scheme = deref(oas, schemes[name]);
      if (!scheme) {
        failures.push({ check: 'security-scheme-missing', detail: `security requirement references undefined scheme '${name}'` });
        continue;
      }
      if (scheme.type === 'oauth2') {
        const declared = new Set(
          Object.values(scheme.flows ?? {}).flatMap((flow) => Object.keys(flow?.scopes ?? {})),
        );
        for (const scope of scopes ?? []) {
          if (!declared.has(scope)) {
            failures.push({ check: 'security-scope-missing', detail: `scheme '${name}' does not declare scope '${scope}'` });
          }
        }
      }
    }
  }
  return failures;
}

function validateMediaExamples(oas, media, label, policy) {
  const schema = media?.schema ? deref(oas, media.schema) : null;
  if (!schema) return [];
  const examples = exampleValues(media, schema);
  const failures = [];
  for (const example of examples) {
    for (const found of validateSchemaValue(oas, schema, example.value, {
      mode: policy.exampleValidationMode ?? 'full',
      path: `$example.${example.name}`,
    })) {
      failures.push({
        check: `example-${found.keyword}`,
        detail: `${label} ${found.path}: ${found.detail}`,
      });
    }
  }
  return failures;
}

/** Audit selected OpenAPI operations for security, negative responses, and valid examples. */
export function auditOas(oas, { subset = null, policy = {} } = {}) {
  const operations = selectedOperations(oas, subset);
  const seenOperationIds = new Set();
  const interactions = operations.map(({ key, operation }) => {
    const failures = [];
    if (policy.requireOperationId === true) {
      if (!operation.operationId) {
        failures.push({ check: 'operation-id-missing', detail: 'operationId is required' });
      } else if (seenOperationIds.has(operation.operationId)) {
        failures.push({ check: 'operation-id-duplicate', detail: `operationId '${operation.operationId}' is duplicated` });
      } else {
        seenOperationIds.add(operation.operationId);
      }
    }
    failures.push(...securityFailures(oas, operation, policy));

    const requestBody = deref(oas, operation.requestBody);
    if (requestBody?.content) {
      const media = jsonMedia(requestBody.content);
      if (media) {
        const schema = media.schema ? deref(oas, media.schema) : null;
        if (policy.requireExamples === true && schema && exampleValues(media, schema).length === 0) {
          failures.push({ check: 'request-example-missing', detail: 'request body schema has no example' });
        }
        failures.push(...validateMediaExamples(oas, media, 'request body', policy));
      }
    }

    const responses = Object.entries(operation.responses ?? {});
    const successes = responses.filter(([status]) => /^2\d\d$/.test(status) || /^2XX$/i.test(status));
    const negatives = responses.filter(([status]) => /^[45]\d\d$/.test(status) || /^[45]XX$/i.test(status));
    if (policy.requireSuccessResponse === true && successes.length === 0) {
      failures.push({ check: 'success-response-missing', detail: 'operation declares no 2xx response' });
    }
    if (policy.requireNegativeResponse === true && negatives.length === 0) {
      failures.push({ check: 'negative-response-missing', detail: 'operation declares no 4xx/5xx response' });
    }
    if (policy.requireExamples === true) {
      for (const [label, group] of [['success', successes], ['negative', negatives]]) {
        const bodyMedia = group
          .map(([, raw]) => jsonMedia(deref(oas, raw)?.content ?? {}))
          .filter((media) => media?.schema);
        if (bodyMedia.length > 0 && !bodyMedia.some((media) =>
          exampleValues(media, deref(oas, media.schema)).length > 0)) {
          failures.push({ check: `${label}-example-missing`, detail: `${label} response schemas have no examples` });
        }
      }
    }
    for (const [status, raw] of responses) {
      const response = deref(oas, raw);
      const media = jsonMedia(response?.content ?? {});
      if (media) failures.push(...validateMediaExamples(oas, media, `response ${status}`, policy));
    }

    return { description: key, ok: failures.length === 0, failures, fields: [] };
  });

  if (operations.length === 0) {
    interactions.push({
      description: 'selected OpenAPI surface is non-empty',
      ok: false,
      failures: [{ check: 'operation-set-empty', detail: 'subset selected zero operations' }],
      fields: [],
    });
  }
  const failed = interactions.filter((interaction) => !interaction.ok).length;
  return {
    consumer: 'oas-audit',
    provider: oas?.info?.title ?? 'provider',
    ok: failed === 0,
    summary: { total: interactions.length, passed: interactions.length - failed, failed },
    interactions,
  };
}
