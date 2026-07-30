#!/usr/bin/env node
// Bidirectional application-route-versus-OAS comparison with rogue-endpoint
// detection. Deterministic JSON-in/JSON-out: same inputs always produce the
// same report, exit code, and JUnit bytes.
//
//   node scripts/compare-routes.mjs \
//     --spec <openapi.json|yaml>           # selected specification (or subset source)
//     --routes <inventory.json>            # live application route inventory
//     [--subset <subset.json>]             # optional spec-subset selector
//     [--exceptions <exceptions.json>]     # approved mismatch exceptions
//     [--strip-prefix </petclinic>]        # base path removed from app routes
//     [--policy block|warn]                # default block
//     [--json-out <report.json>] [--junit-out <report.xml>]
//
// Route inventory formats accepted (auto-detected):
//   1. Generated OpenAPI (springdoc /v3/api-docs): paths+methods are extracted.
//   2. Spring Boot Actuator /actuator/mappings JSON (preferred when exposed).
//   3. Plain records: [{"method":"GET","path":"/api/pets"}, ...]
//
// Subset selector (strawman for PayPal's application-to-spec-subset mapping —
// one app may map to a slice of one or many specs):
//   { "include": [{"pathPrefix": "/api"}, {"method": "GET", "path": "/x"}],
//     "exclude": [{"pathPrefix": "/api/pettypes"}] }
// Empty/absent include means "everything"; exclude wins over include.
//
// Exceptions (approved-mismatch register; block policy skips these):
//   [ {"kind": "rogue"|"missing", "method": "GET", "path": "/api/x",
//      "reason": "...", "approvedBy": "..."} ]
import { readFileSync, writeFileSync } from 'node:fs';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export function normalizePath(path) {
  // Template every path parameter to {} so {petId}, {id}, {*path} and OAS
  // {name} variants compare equal; collapse duplicate and trailing slashes.
  let p = String(path).trim();
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\{[^}]*\}/g, '{}');
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export function routeKey(method, path) {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

export function extractSpecRoutes(specDoc) {
  const routes = [];
  for (const [path, item] of Object.entries(specDoc.paths ?? {})) {
    for (const method of Object.keys(item ?? {})) {
      if (HTTP_METHODS.includes(method.toLowerCase())) {
        routes.push({ method: method.toUpperCase(), path });
      }
    }
  }
  return routes;
}

export function extractAppRoutes(inventory, stripPrefix = '') {
  let records = [];
  if (Array.isArray(inventory)) {
    records = inventory.map((r) => ({ method: r.method, path: r.path }));
  } else if (inventory.paths) {
    records = extractSpecRoutes(inventory); // generated OpenAPI
  } else if (inventory.contexts) {
    // Spring Boot Actuator mappings shape
    for (const ctx of Object.values(inventory.contexts)) {
      const maps = ctx.mappings?.dispatcherServlets ?? {};
      for (const servlet of Object.values(maps)) {
        for (const m of servlet) {
          const cond = m.details?.requestMappingConditions;
          if (!cond?.patterns?.length) continue;
          const methods = cond.methods?.length ? cond.methods : ['GET'];
          for (const pattern of cond.patterns) {
            for (const method of methods) records.push({ method, path: pattern });
          }
        }
      }
    }
  } else {
    throw new Error('Unrecognized route inventory format.');
  }
  return records
    .filter((r) => r.method && r.path)
    .map((r) => ({
      method: r.method.toUpperCase(),
      path:
        stripPrefix && r.path.startsWith(stripPrefix)
          ? r.path.slice(stripPrefix.length) || '/'
          : r.path,
    }));
}

function matchesSelector(route, selector) {
  if (selector.method && selector.method.toUpperCase() !== route.method) return false;
  if (selector.path) return normalizePath(selector.path) === normalizePath(route.path);
  if (selector.pathPrefix) return normalizePath(route.path).startsWith(normalizePath(selector.pathPrefix));
  return Boolean(selector.method);
}

export function applySubset(routes, subset) {
  if (!subset) return routes;
  const include = subset.include ?? [];
  const exclude = subset.exclude ?? [];
  return routes.filter((r) => {
    if (exclude.some((s) => matchesSelector(r, s))) return false;
    if (!include.length) return true;
    return include.some((s) => matchesSelector(r, s));
  });
}

export function compare(specRoutes, appRoutes, exceptions = []) {
  const specKeys = new Map(specRoutes.map((r) => [routeKey(r.method, r.path), r]));
  const appKeys = new Map(appRoutes.map((r) => [routeKey(r.method, r.path), r]));
  const excepted = (kind, key) =>
    exceptions.find((e) => e.kind === kind && routeKey(e.method, e.path) === key);

  const matched = [];
  const missingInApp = [];
  const rogueInApp = [];
  for (const [key, r] of [...specKeys.entries()].sort()) {
    if (appKeys.has(key)) matched.push({ ...r, key });
    else missingInApp.push({ ...r, key, exception: excepted('missing', key) ?? null });
  }
  for (const [key, r] of [...appKeys.entries()].sort()) {
    if (!specKeys.has(key)) rogueInApp.push({ ...r, key, exception: excepted('rogue', key) ?? null });
  }
  const blocking = [...missingInApp, ...rogueInApp].filter((r) => !r.exception);
  return { matched, missingInApp, rogueInApp, blocking };
}

function junitEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toJUnit(result) {
  const cases = [];
  for (const m of result.matched) {
    cases.push(`    <testcase classname="route-contract.matched" name="${junitEscape(m.key)}"/>`);
  }
  for (const m of result.missingInApp) {
    const name = junitEscape(m.key);
    cases.push(
      m.exception
        ? `    <testcase classname="route-contract.missing-in-app" name="${name}"><skipped message="approved exception: ${junitEscape(m.exception.reason ?? '')}"/></testcase>`
        : `    <testcase classname="route-contract.missing-in-app" name="${name}"><failure message="Spec endpoint is not implemented by the application"/></testcase>`,
    );
  }
  for (const r of result.rogueInApp) {
    const name = junitEscape(r.key);
    cases.push(
      r.exception
        ? `    <testcase classname="route-contract.rogue-endpoint" name="${name}"><skipped message="approved exception: ${junitEscape(r.exception.reason ?? '')}"/></testcase>`
        : `    <testcase classname="route-contract.rogue-endpoint" name="${name}"><failure message="Application exposes an endpoint that is absent from the selected specification"/></testcase>`,
    );
  }
  const tests = cases.length;
  const failures = result.blocking.length;
  const skipped = result.missingInApp.length + result.rogueInApp.length - failures;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="route-contract" tests="${tests}" failures="${failures}" skipped="${skipped}">`,
    `  <testsuite name="spec-versus-application" tests="${tests}" failures="${failures}" skipped="${skipped}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

async function loadDoc(file) {
  const text = readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    // YAML specs need the yaml package (repo devDependency); JSON inputs are
    // dependency-free so the script also runs standalone inside runner images.
    const { parse } = await import('yaml');
    return parse(text);
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const spec = await loadDoc(arg('spec'));
  const inventory = await loadDoc(arg('routes'));
  const subset = arg('subset') ? await loadDoc(arg('subset')) : null;
  const exceptions = arg('exceptions') ? await loadDoc(arg('exceptions')) : [];
  const policy = arg('policy', 'block');
  const stripPrefix = arg('strip-prefix', '');

  const specRoutes = applySubset(extractSpecRoutes(spec), subset);
  const appRoutes = applySubset(extractAppRoutes(inventory, stripPrefix), subset);
  const result = compare(specRoutes, appRoutes, exceptions);

  const report = {
    policy,
    counts: {
      specRoutes: specRoutes.length,
      appRoutes: appRoutes.length,
      matched: result.matched.length,
      missingInApp: result.missingInApp.length,
      rogueInApp: result.rogueInApp.length,
      blocking: result.blocking.length,
    },
    missingInApp: result.missingInApp,
    rogueInApp: result.rogueInApp,
    matched: result.matched.map((m) => m.key),
  };
  if (arg('json-out')) writeFileSync(arg('json-out'), `${JSON.stringify(report, null, 2)}\n`);
  if (arg('junit-out')) writeFileSync(arg('junit-out'), toJUnit(result));
  console.log(
    `route-contract: ${report.counts.matched} matched, ${report.counts.missingInApp} missing-in-app, ` +
    `${report.counts.rogueInApp} rogue, ${report.counts.blocking} blocking (policy=${policy})`,
  );
  for (const m of result.missingInApp) console.log(`  MISSING ${m.key}${m.exception ? ' [excepted]' : ''}`);
  for (const r of result.rogueInApp) console.log(`  ROGUE   ${r.key}${r.exception ? ' [excepted]' : ''}`);
  if (policy === 'block' && result.blocking.length) process.exit(1);
}
