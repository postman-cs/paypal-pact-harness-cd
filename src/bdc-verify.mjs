// BDC cross-verify — the owned core (Decision D2/D3). Statically checks a consumer
// Pact v3 contract against the provider's OAS, WITHOUT running the provider. This
// is what catches "the codegen still matches the OAS, but this OAS change silently
// breaks a real consumer": if the OAS renames/drops/retypes a field the consumer
// reads, or stops documenting a status/endpoint the consumer calls, verification
// fails here — before deploy.

import { expectedTypes } from './lib/pact.mjs';
import {
  operationFor,
  responseSchemaFor,
  schemaTypeAtPath,
  typeCompatible,
  deref,
} from './lib/oas.mjs';

/** Collect the provider's required query parameters for an operation (deref'd). */
function requiredQueryParams(oas, operation) {
  const out = [];
  for (const p of operation?.parameters ?? []) {
    const param = deref(oas, p);
    if (param?.in === 'query' && param?.required === true) out.push(param.name);
  }
  return out;
}

/**
 * Verify one consumer interaction against the OAS.
 * @returns {{ description: string, ok: boolean, failures: Array<{check: string, detail: string}> }}
 */
export function verifyInteraction(oas, interaction) {
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
  const { operation } = match;

  // 2. Required query params the provider demands must be sent by the consumer.
  const sent = new Set(Object.keys(req.query ?? {}));
  for (const name of requiredQueryParams(oas, operation)) {
    if (!sent.has(name)) {
      failures.push({ check: 'request-required-param', detail: `provider requires query param '${name}' which the consumer does not send` });
    }
  }

  // 3. The status the consumer expects must be documented.
  const responses = operation.responses ?? {};
  const statusKey = String(res.status);
  const statusDocumented =
    responses[statusKey] || responses[`${statusKey[0]}XX`] || responses.default;
  if (!statusDocumented) {
    failures.push({ check: 'response-status', detail: `provider does not document a ${statusKey} response` });
    return { description: interaction.description, ok: failures.length === 0, failures, fields: [] };
  }

  // 4. Every field the consumer READS must exist in the provider's response schema
  //    with a compatible type. (The consumer's example response = what it depends on.)
  //    `fields` records the per-field verdict so a UI can render field-by-field.
  const fields = [];
  if (res.body !== undefined && res.body !== null && typeof res.body !== 'string') {
    const schema = responseSchemaFor(oas, operation, res.status);
    if (!schema) {
      failures.push({ check: 'response-body-schema', detail: `provider documents no ${statusKey} JSON body schema, but the consumer relies on one` });
    } else {
      for (const [fieldPath, consumerType] of Object.entries(expectedTypes(res.body))) {
        if (fieldPath === '$') continue; // root container type is implied by its fields
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
    }
  }

  return { description: interaction.description, ok: failures.length === 0, failures, fields };
}

/**
 * Cross-verify a whole consumer pact against a provider OAS.
 * @param {object} oas   Parsed OpenAPI document.
 * @param {object} pact  Parsed Pact v3 consumer contract.
 */
export function bdcVerify(oas, pact) {
  const sourceInteractions = pact.interactions ?? [];
  const interactions = sourceInteractions.length
    ? sourceInteractions.map((i) => verifyInteraction(oas, i))
    : [{
        description: 'consumer contract contains interactions',
        ok: false,
        failures: [{
          check: 'contract-empty',
          detail: 'consumer contract has no interactions; refusing a vacuous pass',
        }],
        fields: [],
      }];
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
