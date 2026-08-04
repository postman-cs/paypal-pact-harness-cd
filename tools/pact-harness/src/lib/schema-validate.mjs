import { deref, flattenAllOf } from './oas.mjs';

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function acceptsType(schema, value) {
  const declared = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
  if (value === null && (schema.nullable || declared.includes('null'))) return true;
  if (declared.length === 0) return true;
  const actual = valueType(value);
  return declared.some((type) =>
    type === actual ||
    (type === 'number' && actual === 'integer') ||
    (type === 'object' && actual === 'object'),
  );
}

function validFormat(format, value) {
  if (typeof value !== 'string') return true;
  switch (format) {
    case 'date-time': return !Number.isNaN(Date.parse(value)) && /[tT]/.test(value);
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
    case 'uuid': return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    case 'email': return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
    case 'uri':
    case 'url':
      try { new URL(value); return true; } catch { return false; }
    case 'ipv4': return /^(\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every((x) => Number(x) <= 255);
    default: return true;
  }
}

function issue(keyword, path, detail) {
  return { keyword, path, detail };
}

/**
 * Validate a concrete request/response/example value against an OpenAPI schema.
 * `partial` is used for consumer response expectations: absent fields are not
 * failures, but every field the consumer relies on is checked deeply.
 */
export function validateSchemaValue(oas, schema, value, options = {}) {
  const mode = options.mode ?? 'full';
  const path = options.path ?? '$';
  const depth = options.depth ?? 0;
  if (depth > 80) return [issue('depth', path, 'schema recursion exceeded 80 levels')];

  const resolved = deref(oas, schema);
  if (!resolved || typeof resolved !== 'object') return [];

  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.flatMap((part) =>
      validateSchemaValue(oas, part, value, { mode, path, depth: depth + 1 }),
    );
  }
  if (Array.isArray(resolved.anyOf) || Array.isArray(resolved.oneOf)) {
    const alternatives = resolved.anyOf ?? resolved.oneOf;
    const results = alternatives.map((part) =>
      validateSchemaValue(oas, part, value, { mode, path, depth: depth + 1 }),
    );
    const passing = results.filter((result) => result.length === 0).length;
    const valid = resolved.oneOf ? passing === 1 : passing >= 1;
    return valid ? [] : [issue(resolved.oneOf ? 'oneOf' : 'anyOf', path, 'value matches no permitted schema alternative')];
  }

  if (!acceptsType(resolved, value)) {
    const expected = Array.isArray(resolved.type) ? resolved.type.join('|') : resolved.type;
    return [issue('type', path, `expected ${expected}, received ${valueType(value)}`)];
  }
  if (value === null) return [];

  const failures = [];
  if (resolved.const !== undefined && value !== resolved.const) {
    failures.push(issue('const', path, `expected ${JSON.stringify(resolved.const)}`));
  }
  if (Array.isArray(resolved.enum) && !resolved.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    failures.push(issue('enum', path, `value ${JSON.stringify(value)} is not in the permitted enum`));
  }

  if (typeof value === 'string') {
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      failures.push(issue('minLength', path, `length ${value.length} is below ${resolved.minLength}`));
    }
    if (resolved.maxLength !== undefined && value.length > resolved.maxLength) {
      failures.push(issue('maxLength', path, `length ${value.length} exceeds ${resolved.maxLength}`));
    }
    if (resolved.pattern) {
      try {
        if (!new RegExp(resolved.pattern, resolved.patternFlags ?? '').test(value)) {
          failures.push(issue('pattern', path, `value does not match ${resolved.pattern}`));
        }
      } catch {
        failures.push(issue('pattern', path, `schema contains invalid pattern ${resolved.pattern}`));
      }
    }
    if (resolved.format && !validFormat(resolved.format, value)) {
      failures.push(issue('format', path, `value is not a valid ${resolved.format}`));
    }
  }

  if (typeof value === 'number') {
    if (resolved.minimum !== undefined && value < resolved.minimum) {
      failures.push(issue('minimum', path, `${value} is below ${resolved.minimum}`));
    }
    if (resolved.maximum !== undefined && value > resolved.maximum) {
      failures.push(issue('maximum', path, `${value} exceeds ${resolved.maximum}`));
    }
    if (resolved.exclusiveMinimum !== undefined) {
      const minimum = typeof resolved.exclusiveMinimum === 'number' ? resolved.exclusiveMinimum : resolved.minimum;
      if (minimum !== undefined && value <= minimum) failures.push(issue('exclusiveMinimum', path, `${value} must exceed ${minimum}`));
    }
    if (resolved.exclusiveMaximum !== undefined) {
      const maximum = typeof resolved.exclusiveMaximum === 'number' ? resolved.exclusiveMaximum : resolved.maximum;
      if (maximum !== undefined && value >= maximum) failures.push(issue('exclusiveMaximum', path, `${value} must be below ${maximum}`));
    }
  }

  if (Array.isArray(value)) {
    if (resolved.minItems !== undefined && value.length < resolved.minItems) {
      failures.push(issue('minItems', path, `${value.length} items is below ${resolved.minItems}`));
    }
    if (resolved.maxItems !== undefined && value.length > resolved.maxItems) {
      failures.push(issue('maxItems', path, `${value.length} items exceeds ${resolved.maxItems}`));
    }
    if (resolved.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
      failures.push(issue('uniqueItems', path, 'array contains duplicate items'));
    }
    if (resolved.items) {
      value.forEach((item, index) => failures.push(
        ...validateSchemaValue(oas, resolved.items, item, {
          mode,
          path: `${path}[${index}]`,
          depth: depth + 1,
        }),
      ));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const flattened = flattenAllOf(oas, resolved);
    if (mode === 'full') {
      for (const name of resolved.required ?? []) {
        if (value[name] === undefined) failures.push(issue('required', `${path}.${name}`, 'required property is absent'));
      }
    }
    for (const [name, child] of Object.entries(value)) {
      const propertySchema = flattened.properties[name];
      if (propertySchema !== undefined) {
        failures.push(...validateSchemaValue(oas, propertySchema, child, {
          mode,
          path: `${path}.${name}`,
          depth: depth + 1,
        }));
      } else if (flattened.additionalProperties === false) {
        failures.push(issue('additionalProperties', `${path}.${name}`, 'property is not accepted by the schema'));
      } else if (flattened.additionalProperties && flattened.additionalProperties !== true) {
        failures.push(...validateSchemaValue(oas, flattened.additionalProperties, child, {
          mode,
          path: `${path}.${name}`,
          depth: depth + 1,
        }));
      }
    }
  }

  return failures;
}
