import { deref, jsonMedia, parametersFor } from './lib/oas.mjs';
import { routeKey, selectedOperations } from './lib/subset.mjs';

function effectiveSchema(oas, raw, depth = 0) {
  const schema = deref(oas, raw);
  if (!schema || typeof schema !== 'object' || depth > 60) return {};
  const merged = {
    ...schema,
    properties: { ...(schema.properties ?? {}) },
    required: [...(schema.required ?? [])],
  };
  delete merged.allOf;
  for (const part of schema.allOf ?? []) {
    const found = effectiveSchema(oas, part, depth + 1);
    Object.assign(merged.properties, found.properties ?? {});
    merged.required = [...new Set([...merged.required, ...(found.required ?? [])])];
    for (const key of ['type', 'items', 'enum', 'format', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'additionalProperties']) {
      if (merged[key] === undefined && found[key] !== undefined) merged[key] = found[key];
    }
  }
  return merged;
}

function typeSet(schema) {
  const value = schema.type;
  if (Array.isArray(value)) return new Set(value);
  if (value) return new Set([value]);
  if (schema.properties && Object.keys(schema.properties).length) return new Set(['object']);
  if (schema.items) return new Set(['array']);
  return new Set(['any']);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function enumSet(schema) {
  return Array.isArray(schema.enum) ? new Set(schema.enum.map((value) => JSON.stringify(value))) : null;
}

function add(changes, check, path, detail) {
  changes.push({ check, path, detail });
}

function compareConstraints(base, candidate, path, direction, changes) {
  if (!sameSet(typeSet(base), typeSet(candidate))) {
    add(changes, 'schema-type-changed', path, `type changed from ${[...typeSet(base)].join('|')} to ${[...typeSet(candidate)].join('|')}`);
  }
  if ((base.format ?? null) !== (candidate.format ?? null)) {
    add(changes, 'schema-format-changed', path, `format changed from ${base.format ?? 'none'} to ${candidate.format ?? 'none'}`);
  }
  if ((base.pattern ?? null) !== (candidate.pattern ?? null) && (base.pattern || candidate.pattern)) {
    add(changes, 'schema-pattern-changed', path, 'pattern constraint changed');
  }

  const baseEnum = enumSet(base);
  const candidateEnum = enumSet(candidate);
  if (baseEnum || candidateEnum) {
    if (!baseEnum || !candidateEnum || !sameSet(baseEnum, candidateEnum)) {
      add(changes, 'schema-enum-changed', path, 'permitted enum values changed');
    }
  }

  const tighter = direction === 'request'
    ? [
        ['minimum', (a, b) => b > a],
        ['minLength', (a, b) => b > a],
        ['minItems', (a, b) => b > a],
        ['maximum', (a, b) => b < a],
        ['maxLength', (a, b) => b < a],
        ['maxItems', (a, b) => b < a],
      ]
    : [
        ['minimum', (a, b) => b < a],
        ['minLength', (a, b) => b < a],
        ['minItems', (a, b) => b < a],
        ['maximum', (a, b) => b > a],
        ['maxLength', (a, b) => b > a],
        ['maxItems', (a, b) => b > a],
      ];
  for (const [keyword, isBreaking] of tighter) {
    if (base[keyword] !== undefined && candidate[keyword] !== undefined && isBreaking(base[keyword], candidate[keyword])) {
      add(changes, `schema-${keyword}-changed`, path, `${keyword} changed from ${base[keyword]} to ${candidate[keyword]}`);
    }
  }
}

function compareSchemas(baseOas, candidateOas, baseRaw, candidateRaw, path, direction, changes, depth = 0) {
  if (depth > 60) {
    add(changes, 'schema-depth', path, 'schema recursion exceeded 60 levels');
    return;
  }
  if (!baseRaw && !candidateRaw) return;
  if (!candidateRaw) {
    add(changes, 'schema-removed', path, 'schema was removed');
    return;
  }
  if (!baseRaw) return;
  const base = effectiveSchema(baseOas, baseRaw, depth);
  const candidate = effectiveSchema(candidateOas, candidateRaw, depth);
  compareConstraints(base, candidate, path, direction, changes);

  const baseRequired = new Set(base.required ?? []);
  const candidateRequired = new Set(candidate.required ?? []);
  if (direction === 'request') {
    for (const name of candidateRequired) {
      if (!baseRequired.has(name)) add(changes, 'request-required-added', `${path}.${name}`, 'candidate makes a previously optional request property required');
    }
  } else {
    for (const name of baseRequired) {
      if (!candidateRequired.has(name)) add(changes, 'response-required-removed', `${path}.${name}`, 'candidate no longer guarantees this response property');
    }
  }

  for (const [name, schema] of Object.entries(base.properties ?? {})) {
    if (candidate.properties?.[name] === undefined) {
      add(changes, `${direction}-property-removed`, `${path}.${name}`, 'documented property was removed');
      continue;
    }
    compareSchemas(baseOas, candidateOas, schema, candidate.properties[name], `${path}.${name}`, direction, changes, depth + 1);
  }
  if (base.items || candidate.items) {
    compareSchemas(baseOas, candidateOas, base.items, candidate.items, `${path}[]`, direction, changes, depth + 1);
  }
}

function requestSchema(oas, operation) {
  const body = deref(oas, operation?.requestBody);
  return jsonMedia(body?.content ?? {})?.schema ?? null;
}

function responseSchema(oas, response) {
  return jsonMedia(deref(oas, response)?.content ?? {})?.schema ?? null;
}

function parameterMap(oas, record) {
  return new Map(parametersFor(oas, record.pathItem, record.operation).map((parameter) => [
    `${parameter.in}:${parameter.name}`,
    parameter,
  ]));
}

function effectiveSecurity(oas, operation) {
  return operation.security ?? oas.security ?? [];
}

/** Conservative, selected-surface OpenAPI breaking-change analysis. */
export function diffOas(baseline, candidate, { subset = null } = {}) {
  const baseOperations = selectedOperations(baseline, subset);
  const candidateOperations = new Map(selectedOperations(candidate, subset).map((record) => [record.key, record]));
  const interactions = [];

  for (const base of baseOperations) {
    const found = candidateOperations.get(base.key);
    const changes = [];
    if (!found) {
      add(changes, 'operation-removed', base.key, 'operation is absent from the candidate specification');
    } else {
      const baseParams = parameterMap(baseline, base);
      const candidateParams = parameterMap(candidate, found);
      for (const [key, parameter] of baseParams) {
        const next = candidateParams.get(key);
        if (!next) {
          add(changes, 'request-parameter-removed', `${base.key} ${key}`, 'documented request parameter was removed');
        } else {
          compareSchemas(baseline, candidate, parameter.schema, next.schema, `$parameter.${key}`, 'request', changes);
        }
      }
      for (const [key, parameter] of candidateParams) {
        if (parameter.required === true && baseParams.get(key)?.required !== true) {
          add(changes, 'request-required-parameter-added', `${base.key} ${key}`, 'candidate adds a required request parameter');
        }
      }
      compareSchemas(
        baseline,
        candidate,
        requestSchema(baseline, base.operation),
        requestSchema(candidate, found.operation),
        '$request',
        'request',
        changes,
      );

      for (const [status, response] of Object.entries(base.operation.responses ?? {})) {
        const next = found.operation.responses?.[status];
        if (!next) {
          add(changes, 'response-status-removed', `${base.key} ${status}`, 'documented response status was removed');
          continue;
        }
        compareSchemas(
          baseline,
          candidate,
          responseSchema(baseline, response),
          responseSchema(candidate, next),
          `$response.${status}`,
          'response',
          changes,
        );
      }
      if (JSON.stringify(effectiveSecurity(baseline, base.operation)) !== JSON.stringify(effectiveSecurity(candidate, found.operation))) {
        add(changes, 'security-requirement-changed', base.key, 'effective security schemes or scopes changed');
      }
    }
    interactions.push({
      description: base.key,
      ok: changes.length === 0,
      failures: changes.map(({ check, path, detail }) => ({ check, detail: `${path}: ${detail}` })),
      fields: [],
    });
  }

  if (baseOperations.length === 0) {
    interactions.push({
      description: 'selected baseline surface is non-empty',
      ok: false,
      failures: [{ check: 'operation-set-empty', detail: 'subset selected zero baseline operations' }],
      fields: [],
    });
  }
  const failed = interactions.filter((interaction) => !interaction.ok).length;
  return {
    consumer: 'oas-diff',
    provider: candidate?.info?.title ?? baseline?.info?.title ?? 'provider',
    ok: failed === 0,
    summary: { total: interactions.length, passed: interactions.length - failed, failed },
    interactions,
    breakingChanges: interactions.flatMap((interaction) =>
      interaction.failures.map((failure) => ({
        operation: interaction.description,
        ...failure,
      })),
    ),
  };
}
