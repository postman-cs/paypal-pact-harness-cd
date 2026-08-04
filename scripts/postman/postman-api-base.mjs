const POSTMAN_API_ORIGIN = 'https://api.postman.com';

export function validatePostmanApiBase(value = POSTMAN_API_ORIGIN) {
  let base;
  try {
    base = new URL(value);
  } catch {
    throw new Error('POSTMAN_API_BASE_URL must be an absolute URL');
  }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('POSTMAN_API_BASE_URL must not contain credentials, a path, query, or fragment');
  }

  if (base.origin !== POSTMAN_API_ORIGIN) {
    throw new Error(`POSTMAN_API_BASE_URL must be ${POSTMAN_API_ORIGIN}`);
  }
  return base;
}

export function postmanApiUrl(path, apiBase = POSTMAN_API_ORIGIN) {
  return new URL(path, validatePostmanApiBase(apiBase));
}

export function validatePostmanApiUrl(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error('Postman API request target must be an absolute URL');
  }
  if (target.username || target.password) {
    throw new Error('Postman API request target must not contain credentials');
  }
  validatePostmanApiBase(target.origin);
  return target;
}

export function redactPostmanSecrets(value, apiKey) {
  let text = String(value ?? '');
  if (apiKey) text = text.split(String(apiKey)).join('[REDACTED]');
  return text.replace(/PMAK-[A-Za-z0-9_-]+/g, '[REDACTED]');
}
