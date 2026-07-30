// Pact Specification v3 core — the contract wire format shared by the transformer
// (postman-to-pact) and the cross-verifier (bdc-verify). Deterministic: stable key
// order, no clock, no randomness (Decision D1, D5). Keeping this the single home of
// the format means the two halves can never disagree about what a pact is.

export const PACT_SPEC_VERSION = '3.0.0';

/** JSON primitive type name for a value — the vocabulary our type-matchers speak. */
export function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'string' | 'number' | 'boolean' | 'object'
}

/**
 * Walk a JSON value and emit a v3 body matchingRules map keyed by JSON-path, so
 * every LEAF is matched by TYPE, not exact value (Decision D7 — non-brittle).
 * Arrays get a `type` match at the array node (min 0) plus per-shape rules from
 * the first element, the standard Pact idiom for "a list of things shaped like X".
 * @param {unknown} value
 * @param {string} path  JSON-path prefix (starts at '$').
 * @param {Record<string, {matchers: object[]}>} out
 * @returns {Record<string, {matchers: object[]}>}
 */
export function typeMatchersFor(value, path = '$', out = {}) {
  const t = jsonType(value);
  if (t === 'object') {
    // Deterministic: sort keys so output is stable regardless of source order.
    for (const key of Object.keys(value).sort()) {
      typeMatchersFor(value[key], `${path}.${key}`, out);
    }
  } else if (t === 'array') {
    out[path] = { matchers: [{ match: 'type', min: 0 }] };
    if (value.length > 0) {
      // Rules derived from the first element apply to every element ([*]).
      typeMatchersFor(value[0], `${path}[*]`, out);
    }
  } else {
    // leaf (string/number/boolean/null) → match by type
    out[path] = { matchers: [{ match: 'type' }] };
  }
  return out;
}

/**
 * The type a consumer expects at each JSON-path of a value — the mirror of
 * `typeMatchersFor`, used by the BDC cross-check to compare against the OAS.
 * Records array/empty-object container types plus every leaf. Path scheme matches
 * `typeMatchersFor` exactly ('$.items[*].sku'), so the two halves stay aligned.
 * @param {unknown} value
 * @param {string} path
 * @param {Record<string,string>} out
 * @returns {Record<string,string>} path -> json type
 */
export function expectedTypes(value, path = '$', out = {}) {
  const t = jsonType(value);
  if (t === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) out[path] = 'object';
    else for (const key of keys.sort()) expectedTypes(value[key], `${path}.${key}`, out);
  } else if (t === 'array') {
    out[path] = 'array';
    if (value.length > 0) expectedTypes(value[0], `${path}[*]`, out);
  } else {
    out[path] = t;
  }
  return out;
}

/**
 * Build a single v3 interaction from a captured consumer request/response pair.
 * @param {{
 *   description: string,
 *   providerState?: string,
 *   request: { method: string, path: string, query?: Record<string,string[]>, headers?: Record<string,string>, body?: unknown },
 *   response: { status: number, headers?: Record<string,string>, body?: unknown },
 * }} io
 */
export function buildInteraction(io) {
  /** @type {any} */
  const request = {
    method: io.request.method.toUpperCase(),
    path: io.request.path,
  };
  if (io.request.query && Object.keys(io.request.query).length > 0) request.query = sortObject(io.request.query);
  if (io.request.headers && Object.keys(io.request.headers).length > 0) request.headers = sortObject(io.request.headers);
  if (io.request.body !== undefined) {
    request.body = io.request.body;
    const bodyRules = typeMatchersFor(io.request.body);
    if (Object.keys(bodyRules).length > 0) request.matchingRules = { body: bodyRules };
  }

  /** @type {any} */
  const response = { status: io.response.status };
  if (io.response.headers && Object.keys(io.response.headers).length > 0) response.headers = sortObject(io.response.headers);
  if (io.response.body !== undefined) {
    response.body = io.response.body;
    const bodyRules = typeMatchersFor(io.response.body);
    if (Object.keys(bodyRules).length > 0) response.matchingRules = { body: bodyRules };
  }

  /** @type {any} */
  const interaction = { description: io.description };
  if (io.providerState) interaction.providerStates = [{ name: io.providerState }];
  interaction.request = request;
  interaction.response = response;
  return interaction;
}

/**
 * Assemble a complete Pact v3 contract. Interactions are sorted by description
 * for deterministic output.
 * @param {string} consumer
 * @param {string} provider
 * @param {object[]} interactions
 */
export function buildPact(consumer, provider, interactions) {
  const sorted = [...interactions].sort((a, b) =>
    String(a.description).localeCompare(String(b.description)));
  return {
    consumer: { name: consumer },
    provider: { name: provider },
    interactions: sorted,
    metadata: {
      pactSpecification: { version: PACT_SPEC_VERSION },
      generatedBy: 'paypal-pact-harness/postman-to-pact',
    },
  };
}

/** Stable, LF-terminated JSON — the canonical on-disk form for every artifact. */
export function serialize(pact) {
  return JSON.stringify(pact, null, 2) + '\n';
}

/** Return a shallow copy of an object with keys sorted (determinism). */
export function sortObject(obj) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}
