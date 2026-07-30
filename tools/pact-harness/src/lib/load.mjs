// Document loading — JSON or YAML, chosen by extension then by content sniff.
// The only place `yaml` (Decision D4, the sole non-stdlib dep) is used.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from '../../vendor/yaml/dist/index.js';

/**
 * Parse a JSON or YAML string into a JS value.
 * @param {string} text
 * @param {string} [hintPath]  Filename, used to prefer a parser by extension.
 */
export function parseDoc(text, hintPath = '') {
  const lower = hintPath.toLowerCase();
  if (lower.endsWith('.json')) return JSON.parse(text);
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return parseYaml(text);
  // No hint: try JSON first (strict), fall back to YAML (superset).
  try {
    return JSON.parse(text);
  } catch {
    return parseYaml(text);
  }
}

/** Read + parse a file. */
export function loadDoc(path) {
  return parseDoc(readFileSync(path, 'utf8'), path);
}
