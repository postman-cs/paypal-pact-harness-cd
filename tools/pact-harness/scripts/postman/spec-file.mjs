import { createHash } from 'node:crypto';
import { parseDoc } from '../../src/lib/load.mjs';
import { postmanApiUrl } from './postman-api-base.mjs';

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortForCanonicalJson(child)]),
  );
}

export function canonicalDocumentSha256(content, label = 'specification') {
  let document;
  try {
    document = parseDoc(content);
  } catch (error) {
    throw new Error(`${label} is not valid JSON or YAML: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${label} must be an object`);
  }
  const canonical = JSON.stringify(sortForCanonicalJson(document));
  return createHash('sha256').update(canonical).digest('hex');
}

export function requireCanonicalSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function postmanSpecFileUrl({ specId, path, apiBase }) {
  const segments = String(path).split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`specification ${specId} file path contains an unsafe segment`);
  }
  const encodedPath = segments.map(encodeURIComponent).join('/');
  return postmanApiUrl(`/specs/${encodeURIComponent(specId)}/files/${encodedPath}`, apiBase);
}

export async function pullSingleRootSpecFile({ specId, apiBase, request, label = 'specification' }) {
  const list = await request(postmanApiUrl(`/specs/${encodeURIComponent(specId)}/files`, apiBase));
  if (!list || typeof list !== 'object' || !Array.isArray(list.files)) {
    throw new Error(`${label} ${specId} file list response is malformed`);
  }
  const roots = list.files.filter((file) => file?.type === 'ROOT');
  if (roots.length !== 1) {
    throw new Error(`${label} ${specId} must have exactly one ROOT file; found ${roots.length}`);
  }
  if (list.files.length !== 1) {
    throw new Error(`${label} ${specId} must be a single-file specification; found ${list.files.length} files`);
  }
  const root = roots[0];
  if (typeof root.path !== 'string' || !root.path.trim()) {
    throw new Error(`${label} ${specId} ROOT file has no path`);
  }
  const file = await request(postmanSpecFileUrl({ specId, path: root.path, apiBase }));
  if (!file || typeof file !== 'object' || typeof file.content !== 'string' || !file.content.trim()) {
    throw new Error(`${label} ${specId} ROOT file response is empty or malformed`);
  }
  if (file.type && file.type !== 'ROOT') {
    throw new Error(`${label} ${specId} ROOT file response has type ${file.type}`);
  }
  if (file.path && file.path !== root.path) {
    throw new Error(`${label} ${specId} ROOT file path changed from ${root.path} to ${file.path}`);
  }
  return {
    content: file.content,
    path: root.path,
    id: file.id ?? root.id ?? null,
  };
}

export function assertCanonicalDigest({ content, expected, label }) {
  const actual = canonicalDocumentSha256(content, label);
  if (expected !== undefined) {
    const approved = requireCanonicalSha256(expected, `${label} approved canonical digest`);
    if (actual !== approved) {
      throw new Error(`${label} canonical digest drift: expected ${approved}, received ${actual}`);
    }
  }
  return actual;
}
