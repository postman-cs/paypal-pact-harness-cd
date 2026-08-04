import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function isPathInside(parent, candidate, { allowEqual = true } = {}) {
  const rel = relative(resolve(parent), resolve(candidate));
  if (rel === '') return allowEqual;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function assertNoSymbolicLinkComponents(path, label = 'path') {
  let current = resolve(path);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} must not use a symbolic link or symbolic-link parent`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(path);
}

export function assertDedicatedSubtreePath({ root, target, subtree, label }) {
  const repositoryRoot = resolve(root);
  const dedicatedRoot = resolve(repositoryRoot, subtree);
  const destination = resolve(target);
  if (!isPathInside(dedicatedRoot, destination)) {
    throw new Error(`${label} must be ${subtree} or a child of that dedicated subtree`);
  }
  assertNoSymbolicLinkComponents(destination, label);
  return destination;
}

export function resolveDedicatedSubtreePath({ root, input, subtree, label }) {
  if (typeof input !== 'string' || !input.trim()) throw new Error(`${label} is required`);
  const value = input.trim();
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} contains forbidden control characters`);
  if (isAbsolute(value)) throw new Error(`${label} must be repository-relative`);
  if (value.replaceAll('\\', '/').split('/').some((component) => component === '..')) {
    throw new Error(`${label} must not contain path traversal components`);
  }
  return assertDedicatedSubtreePath({
    root,
    target: resolve(root, value),
    subtree,
    label,
  });
}
