// postman-to-pact — the connective tissue PayPal said "can't be done natively in
// Postman": a Postman v2.1 collection (requests + SAVED EXAMPLE RESPONSES) becomes
// a Pact v3 consumer contract with TYPE matchers (Decision D7 — non-brittle).
//
// The example responses a team already keeps in a collection ARE that consumer's
// expectations; each becomes an interaction. Pure/deterministic (D5).

import { buildInteraction, buildPact } from './lib/pact.mjs';

// Header keys that are transport/volatile noise, not part of the contract shape.
// Dropped so contracts don't pin tokens, request ids, timestamps, etc.
const VOLATILE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'host', 'user-agent', 'date',
  'postman-token', 'x-request-id', 'x-correlation-id', 'content-length',
  'connection', 'accept-encoding', 'cache-control', 'pragma',
]);

/** Flatten Postman's [{key,value,disabled}] header list into a plain object. */
function headersToObject(list, { dropVolatile }) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const h of list ?? []) {
    if (!h || h.disabled) continue;
    const key = String(h.key ?? '').trim();
    if (!key) continue;
    if (dropVolatile && VOLATILE_HEADERS.has(key.toLowerCase())) continue;
    out[key] = String(h.value ?? '');
  }
  return out;
}

/** Postman url.query [{key,value,disabled}] → Pact v3 query {key: [values]}. */
function queryToObject(query) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const q of query ?? []) {
    if (!q || q.disabled) continue;
    const key = String(q.key ?? '').trim();
    if (!key) continue;
    (out[key] ??= []).push(String(q.value ?? ''));
  }
  return out;
}

/** Build a leading-slash path from a Postman url.path array (or a raw string). */
function pathFromUrl(url) {
  if (!url) return '/';
  if (typeof url === 'string') {
    try {
      return new URL(url).pathname || '/';
    } catch {
      // relative or templated — strip query/host best-effort
      const noQuery = url.split('?')[0];
      return noQuery.startsWith('/') ? noQuery : `/${noQuery}`;
    }
  }
  const segs = (url.path ?? []).map((s) => (typeof s === 'string' ? s : s?.value ?? ''));
  return '/' + segs.join('/');
}

function declaresJson(headers, body) {
  const contentType = (headers ?? []).find((header) =>
    !header?.disabled && String(header?.key ?? '').toLowerCase() === 'content-type');
  return String(contentType?.value ?? '').toLowerCase().includes('json') ||
    String(body?.options?.raw?.language ?? '').toLowerCase() === 'json';
}

/** Parse a body string as JSON when possible; never hide malformed declared JSON as text. */
function parseBody(raw, { json, label }) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    if (json) throw new Error(`${label} declares JSON but is not valid JSON`);
    return raw;
  }
}

/** Recursively collect every item that carries a `request` (Postman folders nest). */
function collectRequests(items, acc = []) {
  for (const item of items ?? []) {
    if (item?.request) acc.push(item);
    if (Array.isArray(item?.item)) collectRequests(item.item, acc);
  }
  return acc;
}

/**
 * Convert a Postman collection to a Pact v3 consumer contract.
 * @param {object} collection  Parsed Postman v2.1 collection.
 * @param {{ consumer?: string, provider: string, includeVolatileHeaders?: boolean }} opts
 * @returns {object} pact
 */
export function postmanToPact(collection, opts) {
  if (!opts?.provider) throw new Error('provider name is required (a collection does not name its provider)');
  const consumer = opts.consumer || collection?.info?.name || 'unknown-consumer';
  const dropVolatile = !opts.includeVolatileHeaders;

  const interactions = [];
  for (const item of collectRequests(collection?.item)) {
    const examples = Array.isArray(item.response) ? item.response : [];
    if (examples.length === 0) continue; // no saved example = no expectation to contract

    for (const example of examples) {
      // Prefer the example's originalRequest (the concrete call that produced it).
      const req = example.originalRequest ?? item.request;
      const request = {
        method: String(req.method ?? 'GET'),
        path: pathFromUrl(req.url),
        query: queryToObject(req.url?.query),
        headers: headersToObject(req.header, { dropVolatile }),
        body: parseBody(req.body?.raw, {
          json: declaresJson(req.header, req.body),
          label: `${item.name ?? 'unnamed request'} request body`,
        }),
      };
      const status = Number(example.code ?? 200);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new Error(`${item.name ?? 'unnamed request'} saved example has an invalid HTTP status`);
      }
      const response = {
        status,
        headers: headersToObject(example.header, { dropVolatile }),
        body: parseBody(example.body, {
          json: declaresJson(example.header),
          label: `${item.name ?? 'unnamed request'} saved response body`,
        }),
      };
      const description = `${item.name} (${response.status})`;
      interactions.push(buildInteraction({ description, request, response }));
    }
  }

  return buildPact(consumer, opts.provider, interactions);
}
