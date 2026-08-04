// BDC cross-verify — the owned core (Decision D2/D3). Statically checks a consumer
// Pact v3 contract against the provider's OAS, WITHOUT running the provider. This
// is what catches "the codegen still matches the OAS, but this OAS change silently
// breaks a real consumer": if the OAS renames/drops/retypes a field the consumer
// reads, or stops documenting a status/endpoint the consumer calls, verification
// fails here — before deploy.

import { expectedTypes } from './lib/pact.mjs';
import {
  operationFor,
  parametersFor,
  requestSchemaFor,
  responseSchemaFor,
  schemaTypeAtPath,
  typeCompatible,
  deref,
} from './lib/oas.mjs';
import { validateSchemaValue } from './lib/schema-validate.mjs';

function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  const found = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === wanted);
  return found?.[1];
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function coerceParameter(value, schema) {
  const raw = firstValue(value);
  if (raw === undefined) return undefined;
  switch (schema?.type) {
    case 'integer': return Number.parseInt(raw, 10);
    case 'number': return Number(raw);
    case 'boolean': return String(raw).toLowerCase() === 'true';
    case 'array': return Array.isArray(value) ? value : String(raw).split(',');
    default: return String(raw);
  }
}

function parameterValue(req, parameter) {
  if (parameter.in === 'query') return req.query?.[parameter.name];
  if (parameter.in === 'header') return headerValue(req.headers, parameter.name);
  if (parameter.in === 'path') return true; // a concrete path already matched the template
  if (parameter.in === 'cookie') return undefined; // cookies are intentionally redacted
  return undefined;
}

function pushSchemaFailures(failures, prefix, issues) {
  for (const found of issues) {
    failures.push({
      check: `${prefix}-${found.keyword}`,
      detail: `${found.path}: ${found.detail}`,
    });
  }
}

/**
 * Verify one consumer interaction against the OAS.
 * @returns {{ description: string, ok: boolean, failures: Array<{check: string, detail: string}> }}
 */
export function verifyInteraction(oas, interaction, policy = {}) {
  const failures = [];
  const req = interaction.request ?? {};
  const res = interaction.response ?? {};
  const method = String(req.method ?? 'GET');
  const path = String(req.path ?? '/');

  // 1. The provider must actually serve this endpoint.
  const match = operationFor(oas, method, path);
  if (!match) {
    failures.push({ check: 'operation-exists', detail: `provider OAS has no ${method} ${path}` });
    return { description: interaction.description, ok: false, failures, fields: [] };
  }
  const { pathItem, operation } = match;

  // 2. Required query/header/path parameters and their concrete example values
  //    must satisfy the provider contract.
  for (const parameter of parametersFor(oas, pathItem, operation)) {
    const value = parameterValue(req, parameter);
    if (parameter.required === true && value === undefined) {
      failures.push({
        check: 'request-required-param',
        detail: `provider requires ${parameter.in} param '${parameter.name}' which the consumer does not send`,
      });
      continue;
    }
    if (value !== undefined && value !== true && parameter.schema) {
      pushSchemaFailures(
        failures,
        'request-param',
        validateSchemaValue(oas, parameter.schema, coerceParameter(value, deref(oas, parameter.schema)), {
          path: `$${parameter.in}.${parameter.name}`,
          mode: 'full',
        }),
      );
    }
  }

  // 3. A concrete consumer request must satisfy the documented request schema.
  const requestBody = deref(oas, operation.requestBody);
  const requestSchema = requestSchemaFor(oas, operation);
  if (requestBody?.required === true && req.body === undefined) {
    failures.push({ check: 'request-body-required', detail: 'provider requires a JSON request body which the consumer does not send' });
  } else if (req.body !== undefined) {
    if (!requestSchema) {
      failures.push({ check: 'request-body-schema', detail: 'consumer sends a JSON body but the provider declares no JSON request schema' });
    } else {
      pushSchemaFailures(
        failures,
        'request-body',
        validateSchemaValue(oas, requestSchema, req.body, { path: '$request', mode: 'full' }),
      );
    }
  }

  // 4. The status the consumer expects must be documented.
  const responses = operation.responses ?? {};
  const statusKey = String(res.status);
  const statusDocumented =
    responses[statusKey] || responses[`${statusKey[0]}XX`] || responses.default;
  if (!statusDocumented) {
    failures.push({ check: 'response-status', detail: `provider does not document a ${statusKey} response` });
    return { description: interaction.description, ok: failures.length === 0, failures, fields: [] };
  }

  // 5. Every field the consumer READS must exist in the provider's response schema
  //    with a compatible type. (The consumer's example response = what it depends on.)
  //    `fields` records the per-field verdict so a UI can render field-by-field.
  const fields = [];
  const responseContentType = String(headerValue(res.headers, 'content-type') ?? '').toLowerCase();
  const bodyIsShapeBearing = typeof res.body !== 'string' || responseContentType.includes('json');
  if (res.body !== undefined && res.body !== null && bodyIsShapeBearing) {
    const schema = responseSchemaFor(oas, operation, res.status);
    if (!schema) {
      failures.push({ check: 'response-body-schema', detail: `provider documents no ${statusKey} JSON body schema, but the consumer relies on one` });
    } else {
      for (const [fieldPath, consumerType] of Object.entries(expectedTypes(res.body))) {
        const found = schemaTypeAtPath(oas, schema, fieldPath);
        if (!found.found) {
          failures.push({ check: 'response-field-missing', detail: `${fieldPath}: ${found.reason} (consumer expects ${consumerType})` });
          fields.push({ path: fieldPath, expects: consumerType, provider: null, ok: false, reason: 'missing' });
        } else if (!typeCompatible(consumerType, found.type)) {
          failures.push({ check: 'response-field-type', detail: `${fieldPath}: consumer expects ${consumerType}, provider declares ${found.type}` });
          fields.push({ path: fieldPath, expects: consumerType, provider: found.type, ok: false, reason: 'type' });
        } else {
          fields.push({ path: fieldPath, expects: consumerType, provider: found.type, ok: true });
        }
      }
      if (policy.validateConsumerExamples === true) {
        const deepIssues = validateSchemaValue(oas, schema, res.body, {
          path: '$response',
          mode: 'partial',
        });
        const existing = new Set(failures.map((failure) => `${failure.check}:${failure.detail}`));
        for (const found of deepIssues) {
          const check = `response-schema-${found.keyword}`;
          const detail = `${found.path}: ${found.detail}`;
          if (!existing.has(`${check}:${detail}`)) failures.push({ check, detail });
        }
      }
    }
  }

  return { description: interaction.description, ok: failures.length === 0, failures, fields };
}

/**
 * Cross-verify a whole consumer pact against a provider OAS.
 * @param {object} oas   Parsed OpenAPI document.
 * @param {object} pact  Parsed Pact v3 consumer contract.
 */
export function bdcVerify(oas, pact, policy = {}) {
  const sourceInteractions = pact.interactions ?? [];
  const interactions = sourceInteractions.length
    ? sourceInteractions.map((i) => verifyInteraction(oas, i, policy))
    : [{
        description: 'consumer contract contains interactions',
        ok: false,
        failures: [{
          check: 'contract-empty',
          detail: 'consumer contract has no interactions; refusing a vacuous pass',
        }],
        fields: [],
      }];
  if (policy.requireNegativeInteractions === true && !sourceInteractions.some((i) => Number(i.response?.status) >= 400)) {
    interactions.push({
      description: 'consumer contract includes at least one negative interaction',
      ok: false,
      failures: [{
        check: 'negative-case-missing',
        detail: 'policy requires at least one consumer-owned 4xx/5xx interaction',
      }],
      fields: [],
    });
  }
  if (policy.requireSuccessInteractions === true && !sourceInteractions.some((i) => Number(i.response?.status) >= 200 && Number(i.response?.status) < 400)) {
    interactions.push({
      description: 'consumer contract includes at least one success interaction',
      ok: false,
      failures: [{
        check: 'success-case-missing',
        detail: 'policy requires at least one consumer-owned 2xx/3xx interaction',
      }],
      fields: [],
    });
  }
  const failed = interactions.filter((i) => !i.ok).length;
  return {
    consumer: pact.consumer?.name ?? 'unknown-consumer',
    provider: pact.provider?.name ?? 'unknown-provider',
    ok: failed === 0,
    summary: { total: interactions.length, passed: interactions.length - failed, failed },
    interactions,
  };
}

/**
 * The can-i-deploy verdict for a single consumer↔provider pair (the per-pair input
 * the git-backed ledger aggregates across all consumers/versions). Deployable iff
 * every interaction verified.
 */
export function canIDeploy(result) {
  const reasons = [];
  for (const i of result.interactions) {
    for (const f of i.failures) reasons.push(`[${i.description}] ${f.check}: ${f.detail}`);
  }
  return {
    consumer: result.consumer,
    provider: result.provider,
    deployable: result.ok,
    reasons,
  };
}
