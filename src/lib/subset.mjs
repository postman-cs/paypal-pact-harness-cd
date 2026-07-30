const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

/** Normalize path-template parameter names so `{id}` and `{order_id}` compare equal. */
export function normalizeTemplate(path) {
  let value = String(path ?? '').trim();
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\{[^}]*\}/g, '{}').replace(/\/{2,}/g, '/');
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

export function routeKey(method, path) {
  return `${String(method).toUpperCase()} ${normalizeTemplate(path)}`;
}

export function matchesSelector(route, selector) {
  if (!selector || typeof selector !== 'object') return false;
  if (selector.method && String(selector.method).toUpperCase() !== route.method) return false;
  if (selector.path) return normalizeTemplate(selector.path) === normalizeTemplate(route.path);
  if (selector.pathPrefix) {
    return normalizeTemplate(route.path).startsWith(normalizeTemplate(selector.pathPrefix));
  }
  return Boolean(selector.method);
}

export function applySubset(routes, subset) {
  if (!subset) return routes;
  const include = subset.include ?? [];
  const exclude = subset.exclude ?? [];
  return routes.filter((route) => {
    if (exclude.some((selector) => matchesSelector(route, selector))) return false;
    return include.length === 0 || include.some((selector) => matchesSelector(route, selector));
  });
}

/** Enumerate selected OAS operations in deterministic order. */
export function selectedOperations(oas, subset) {
  const routes = [];
  for (const [path, item] of Object.entries(oas?.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      routes.push({
        method: method.toUpperCase(),
        path,
        pathItem: item,
        operation,
        key: routeKey(method, path),
      });
    }
  }
  return applySubset(routes, subset).sort((a, b) => a.key.localeCompare(b.key));
}
