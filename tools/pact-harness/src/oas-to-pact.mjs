// oas-to-pact — derive a CONSUMER contract from a consumer OAS (the subset of the
// provider API the consumer declares it needs). In an OAS-first shop both sides come
// from OAS: the provider publishes its full OAS, the consumer publishes a (smaller)
// OAS of what it consumes. This turns the consumer's OAS into a Pact contract so the
// same bdc-verify (consumer contract × provider OAS) cross-checks OAS-against-OAS.
//
// Sits beside postman-to-pact: a consumer contract can be sourced from a Postman
// collection OR an OAS — both become a Pact contract, verified the same way.

import { buildInteraction, buildPact } from './lib/pact.mjs';
import { flattenAllOf, deref } from './lib/oas.mjs';

const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

/** Synthesize a representative example value from a schema so the declared shape
 *  becomes the consumer's expected response body (type-checked downstream). */
function synth(oas, schema, depth = 0) {
  if (depth > 40) return 'x';
  const resolved = deref(oas, schema) ?? {};
  if (resolved.example !== undefined) return resolved.example;
  if (resolved.default !== undefined) return resolved.default;
  if (Array.isArray(resolved.enum) && resolved.enum.length > 0) return resolved.enum[0];
  const f = flattenAllOf(oas, schema);
  switch (f.type) {
    case 'object': {
      const o = {};
      for (const [k, ps] of Object.entries(f.properties ?? {})) o[k] = synth(oas, ps, depth + 1);
      return o;
    }
    case 'array': return f.items ? [synth(oas, f.items, depth + 1)] : [];
    case 'integer': case 'number': return 1;
    case 'boolean': return true;
    default:
      if (resolved.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (resolved.format === 'date') return '2026-01-01';
      if (resolved.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (resolved.format === 'email') return 'consumer@example.test';
      if (resolved.pattern && /\\d|\[0-9\]/.test(resolved.pattern)) return '1.00';
      return 'SAMPLE'; // string / any
  }
}

/** Every explicit JSON response the consumer declares it handles. */
function contractResponses(oas, op) {
  const responses = op.responses ?? {};
  return Object.entries(responses).flatMap(([key, value]) => {
    const normalized = key.toUpperCase();
    if (!/^[1-5]\d\d$/.test(normalized) && !/^[1-5]XX$/.test(normalized) && normalized !== 'DEFAULT') {
      return [];
    }
    const resp = deref(oas, value) ?? {};
    const content = resp.content ?? {};
    const media = content['application/json'] ?? content[Object.keys(content).find((type) => type.includes('json')) ?? ''];
    const status = /^\d+$/.test(normalized)
      ? Number(normalized)
      : (normalized === 'DEFAULT' ? 200 : Number(`${normalized[0]}00`));
    return [{ key, status, schema: media?.schema }];
  });
}

const concretePath = (p) => p.replace(/\{[^}]+\}/g, 'sample');

/**
 * Convert a consumer OAS into a Pact v3 consumer contract.
 * @param {object} consumerOas
 * @param {{ consumer?: string, provider: string }} opts
 */
export function oasToPact(consumerOas, opts) {
  if (!opts?.provider) throw new Error('provider name is required');
  const consumer = opts.consumer || consumerOas?.info?.title || 'consumer';
  const interactions = [];
  for (const [pathKey, item] of Object.entries(consumerOas?.paths ?? {})) {
    for (const method of Object.keys(item ?? {})) {
      if (!METHODS.has(method)) continue;
      const op = item[method];
      const responses = contractResponses(consumerOas, op);
      for (const response of responses) {
        const operation = op.operationId || `${method.toUpperCase()} ${pathKey}`;
        interactions.push(buildInteraction({
          description: `${operation} (${response.key})`,
          request: { method: method.toUpperCase(), path: concretePath(pathKey) },
          response: {
            status: response.status,
            body: response.schema ? synth(consumerOas, response.schema) : undefined,
          },
        }));
      }
    }
  }
  return buildPact(consumer, opts.provider, interactions);
}
