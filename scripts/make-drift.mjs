#!/usr/bin/env node
// Produce a DRIFTED copy of a real PayPal spec by applying ONE realistic breaking
// change to a response schema. Every one of these still matches the provider's own
// (regenerated) OAS — provider-driven testing stays green — but breaks a consumer
// that reads the affected field. Deterministic: same input + op -> same drift.
//
//   node scripts/make-drift.mjs --in <spec> --out <spec> --schema order --rename status:order_status
//   node scripts/make-drift.mjs --in <spec> --out <spec> --schema order --remove intent
//   node scripts/make-drift.mjs --in <spec> --out <spec> --schema order --retype id:integer
//
// Ops (schema-level, the common breaking-change classes):
//   --rename from:to   rename a response field
//   --remove field     drop a response field
//   --retype field:t   change a response field's declared type

import { readFileSync, writeFileSync } from 'node:fs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const inPath = arg('in');
const outPath = arg('out');
const schemaName = arg('schema') || 'order';
if (!inPath || !outPath) { console.error('usage: --in <spec> --out <spec> --schema <name> --rename|--remove|--retype ...'); process.exit(2); }

const spec = JSON.parse(readFileSync(inPath, 'utf8'));
const target = spec.components?.schemas?.[schemaName];
if (!target) { console.error(`schema '${schemaName}' not found`); process.exit(1); }

/** Apply `fn(node.properties)` wherever a schema (or an allOf member) declares properties. */
function forEachPropertyBag(schema, fn) {
  let hits = 0;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) hits += fn(node.properties) ? 1 : 0;
    for (const sub of node.allOf ?? []) visit(sub);
  };
  visit(schema);
  return hits;
}

let summary;
if (arg('rename')) {
  const [from, to] = arg('rename').split(':');
  const n = forEachPropertyBag(target, (props) => {
    if (Object.prototype.hasOwnProperty.call(props, from)) { props[to] = props[from]; delete props[from]; return true; }
    return false;
  });
  if (!n) { console.error(`property '${from}' not found on '${schemaName}'`); process.exit(1); }
  summary = `renamed '${from}' -> '${to}'`;
} else if (arg('remove')) {
  const field = arg('remove');
  const n = forEachPropertyBag(target, (props) => {
    if (Object.prototype.hasOwnProperty.call(props, field)) { delete props[field]; return true; }
    return false;
  });
  if (!n) { console.error(`property '${field}' not found on '${schemaName}'`); process.exit(1); }
  summary = `removed '${field}'`;
} else if (arg('retype')) {
  const [field, type] = arg('retype').split(':');
  const n = forEachPropertyBag(target, (props) => {
    if (Object.prototype.hasOwnProperty.call(props, field)) {
      // replace with a plain typed schema (drop any $ref/allOf so the new type is authoritative)
      props[field] = { type };
      return true;
    }
    return false;
  });
  if (!n) { console.error(`property '${field}' not found on '${schemaName}'`); process.exit(1); }
  summary = `retyped '${field}' -> ${type}`;
} else {
  console.error('one of --rename / --remove / --retype is required'); process.exit(2);
}

if (spec.info) spec.info.version = `${spec.info.version || '0'}-drift`;
writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
console.log(`[drift] ${summary} on schema '${schemaName}'; wrote ${outPath}`);
