import { createHash } from 'node:crypto';

const SERVER_MANAGED_FIELDS = new Set([
  '_postman_id',
  '_exporter_id',
  '_collection_link',
  '_postman_previewlanguage',
  'createdAt',
  'updatedAt',
  'lastUpdatedBy',
  'uid',
  'id',
]);

function isStructuredUrl(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    ['protocol', 'host', 'port', 'path', 'query', 'variable'].some((field) => field in value);
}

function absoluteUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return {
      protocol: parsed.protocol.slice(0, -1).toLowerCase(),
      host: parsed.hostname.toLowerCase().split('.'),
      ...(parsed.port ? { port: parsed.port } : {}),
      path: parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent),
      ...(parsed.searchParams.size > 0
        ? { query: [...parsed.searchParams].map(([key, itemValue]) => ({ key, value: itemValue })) }
        : {}),
      ...(parsed.hash ? { hash: parsed.hash.slice(1) } : {}),
    };
  } catch {
    return null;
  }
}

function stable(value, parentKey = '') {
  if (parentKey === 'url' && typeof value === 'string') {
    return absoluteUrl(value) ?? { raw: value };
  }
  if (Array.isArray(value)) return value.map((entry) => stable(entry));
  if (!value || typeof value !== 'object') return value;

  if (parentKey === 'url' && typeof value.raw === 'string' && /\{\{[^}]+\}\}/.test(value.raw)) {
    return { raw: value.raw };
  }

  const structuredUrl = parentKey === 'url' && isStructuredUrl(value);
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !SERVER_MANAGED_FIELDS.has(key))
      .filter((key) => !(structuredUrl && key === 'raw'))
      .filter((key) => !(key === 'cookie' && Array.isArray(value[key]) && value[key].length === 0))
      .filter((key) => !(key === 'responseTime' && value[key] === null))
      .filter((key) => !(key === 'response' && Array.isArray(value[key]) && value[key].length === 0))
      .filter((key) => !(parentKey === 'script' && key === 'type' && value[key] === 'text/javascript'))
      .sort()
      .map((key) => [key, stable(value[key], key)]),
  );
}

export function canonicalCollection(collection) {
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) {
    throw new Error('Postman collection must be an object');
  }
  return stable(structuredClone(collection));
}

export function canonicalCollectionContent(collection) {
  return `${JSON.stringify(canonicalCollection(collection), null, 2)}\n`;
}

export function canonicalCollectionSha256(collection) {
  return createHash('sha256').update(canonicalCollectionContent(collection)).digest('hex');
}

export function requireCollectionCanonicalSha256(value, label = 'approved collection canonical digest') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

export function assertCollectionCanonicalDigest({
  collection,
  expected,
  label = 'Postman collection',
}) {
  const approved = requireCollectionCanonicalSha256(expected, `${label} approved canonical digest`);
  const actual = canonicalCollectionSha256(collection);
  if (actual !== approved) {
    throw new Error(
      `${label} canonical digest drift: expected ${approved}, received ${actual}`,
    );
  }
  return actual;
}
