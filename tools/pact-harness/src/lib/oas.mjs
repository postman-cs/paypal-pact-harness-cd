// OpenAPI navigation for the BDC cross-check. Just enough to resolve an operation
// for a concrete request and to look up the declared TYPE of a response field by
// JSON-path. Pure; no network; handles local `#/...` $refs.

/** Resolve a local `#/...` JSON-pointer $ref against the root document. */
export function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

/** Follow a single level of $ref (if present) to the concrete schema node. */
export function deref(root, schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 50) return schema;
  if (schema.$ref) return deref(root, resolveRef(root, schema.$ref), depth + 1);
  return schema;
}

/** Does an OAS path template (`/orders/{id}`) match a concrete path (`/orders/123`)? */
export function pathMatches(template, concrete) {
  const t = template.split('/').filter(Boolean);
  const c = concrete.split('/').filter(Boolean);
  if (t.length !== c.length) return false;
  for (let i = 0; i < t.length; i++) {
    const seg = t[i];
    const isParam = seg.startsWith('{') && seg.endsWith('}');
    if (!isParam && seg !== c[i]) return false;
  }
  return true;
}

const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

/**
 * Find the OAS operation serving a concrete method+path.
 * @returns {{ pathKey: string, method: string, operation: object }|null}
 */
export function operationFor(oas, method, concretePath) {
  const m = method.toLowerCase();
  const paths = oas?.paths ?? {};
  for (const pathKey of Object.keys(paths)) {
    if (!pathMatches(pathKey, concretePath)) continue;
    const item = paths[pathKey] ?? {};
    if (item[m]) return { pathKey, method: m, operation: item[m] };
  }
  return null;
}

/**
 * The response schema an operation declares for a status + JSON content type.
 * Falls back to `default`. Returns the raw (still possibly $ref'd) schema or null.
 */
export function responseSchemaFor(oas, operation, status, contentType = 'application/json') {
  const responses = operation?.responses ?? {};
  const key = String(status);
  const resp = responses[key] ?? responses[`${key[0]}XX`] ?? responses.default;
  if (!resp) return null;
  const content = deref(oas, resp).content ?? {};
  const media = content[contentType]
    ?? content[Object.keys(content).find((c) => c.includes('json')) ?? ''];
  return media?.schema ?? null;
}

/**
 * Flatten a schema to an effective object view, MERGING `allOf` members so that
 * composed schemas (which PayPal's specs use pervasively) expose their real
 * properties/type — without this, drift inside an allOf is invisible. `oneOf`/
 * `anyOf` stay `composed` (genuine polymorphism → matched leniently).
 * @returns {{ type: string, properties: Record<string,object>, items?: object, additionalProperties?: unknown, composed: boolean }}
 */
export function flattenAllOf(oas, schema, depth = 0) {
  const s = deref(oas, schema);
  if (!s || typeof s !== 'object' || depth > 60) return { type: 'any', properties: {}, composed: false };
  /** @type {Record<string, object>} */
  const properties = {};
  let type = Array.isArray(s.type) ? s.type[0] : s.type;
  let items = s.items;
  let additionalProperties = s.additionalProperties;
  let composed = Boolean(s.oneOf || s.anyOf);
  if (s.properties) Object.assign(properties, s.properties);
  for (const sub of s.allOf ?? []) {
    const f = flattenAllOf(oas, sub, depth + 1);
    Object.assign(properties, f.properties);
    type = type || f.type;
    items = items || f.items;
    additionalProperties = additionalProperties ?? f.additionalProperties;
    composed = composed || f.composed;
  }
  if (!type || type === 'any') {
    if (Object.keys(properties).length > 0 || additionalProperties) type = 'object';
    else if (items) type = 'array';
    else if (s.enum) type = typeof s.enum[0];
    else type = composed ? 'any' : (type || 'any');
  }
  return { type, properties, items, additionalProperties, composed };
}

/** Normalize a schema node to a single JSON type name our matchers speak. */
export function schemaType(oas, schema) {
  return flattenAllOf(oas, schema).type;
}

/**
 * Parse a Pact body JSON-path ('$.items[*].sku') into navigation steps.
 * @returns {Array<{kind:'prop', key:string}|{kind:'item'}>}
 */
export function parsePath(path) {
  const steps = [];
  const body = path.startsWith('$') ? path.slice(1) : path;
  // Split into '.key' and '[*]' tokens.
  const re = /\.([^.\[]+)|(\[\*\])/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[1] !== undefined) steps.push({ kind: 'prop', key: m[1] });
    else steps.push({ kind: 'item' });
  }
  return steps;
}

/**
 * Walk an OAS schema to a Pact body JSON-path and report the declared type.
 * @returns {{ found: true, type: string } | { found: false, reason: string }}
 */
export function schemaTypeAtPath(oas, rootSchema, path) {
  if (!deref(oas, rootSchema)) return { found: false, reason: 'no response schema declared' };
  let cur = rootSchema;
  for (const step of parsePath(path)) {
    const f = flattenAllOf(oas, cur);
    if (step.kind === 'prop') {
      if (f.properties[step.key] !== undefined) {
        cur = f.properties[step.key];
      } else if (f.additionalProperties && f.additionalProperties !== false) {
        cur = f.additionalProperties === true ? { type: 'any' } : f.additionalProperties;
      } else if (f.composed) {
        return { found: true, type: 'any' }; // oneOf/anyOf polymorphism — don't over-assert
      } else {
        return { found: false, reason: `provider schema has no property '${step.key}'` };
      }
    } else {
      if (f.items) cur = f.items;
      else return { found: false, reason: 'provider schema is not an array here' };
    }
  }
  return { found: true, type: schemaType(oas, cur) };
}

/** Is a provider-declared type compatible with a consumer-expected type? */
export function typeCompatible(consumerType, providerType) {
  if (providerType === 'any' || consumerType === 'null') return true; // lenient where we can't assert
  if (consumerType === 'number') return providerType === 'number' || providerType === 'integer';
  if (consumerType === 'object') return providerType === 'object';
  if (consumerType === 'array') return providerType === 'array';
  return consumerType === providerType;
}
