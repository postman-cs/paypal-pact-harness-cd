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
    default: return 'x'; // string / enum / any
  }
}

/** The first success (2xx/default) JSON response of an operation. */
function successResponse(oas, op) {
  const responses = op.responses ?? {};
  const key = Object.keys(responses).find((k) => /^2\d\d$/.test(k))
    ?? (responses['2XX'] ? '2XX' : (responses.default ? 'default' : null));
  if (!key) return null;
  const resp = deref(oas, responses[key]) ?? {};
  const content = resp.content ?? {};
  const media = content['application/json'] ?? content[Object.keys(content).find((c) => c.includes('json')) ?? ''];
  return { status: /^\d+$/.test(key) ? Number(key) : 200, schema: media?.schema };
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
      const sr = successResponse(consumerOas, op);
      if (!sr) continue;
      interactions.push(buildInteraction({
        description: op.operationId || `${method.toUpperCase()} ${pathKey}`,
        request: { method: method.toUpperCase(), path: concretePath(pathKey) },
        response: { status: sr.status, body: sr.schema ? synth(consumerOas, sr.schema) : undefined },
      }));
    }
  }
  return buildPact(consumer, opts.provider, interactions);
}
