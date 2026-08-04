#!/usr/bin/env node

const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};

function positiveInteger(value, name, fallback) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 300) {
    throw new Error(`${name} must be an integer between 1 and 300`);
  }
  return candidate;
}

export async function waitForProvider({
  url,
  bearerToken,
  attempts = 60,
  intervalMs = 2_000,
  timeoutMs = 5_000,
  fetchImpl = fetch,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const target = new URL(required(url, 'provider readiness URL'));
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('provider readiness URL must be credential-free HTTP(S)');
  }
  const maxAttempts = positiveInteger(attempts, 'attempts', 60);
  const delay = positiveInteger(intervalMs, 'intervalMs', 2_000);
  const timeout = positiveInteger(timeoutMs, 'timeoutMs', 5_000);
  const headers = bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(target, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      });
      if (response.ok) return { attempts: attempt, status: response.status };
    } catch {
      // A provider that is still starting is expected. The final error is generic
      // so neither a credential nor a sensitive URL is copied into CI logs.
    }
    if (attempt < maxAttempts) await sleepImpl(delay);
  }
  throw new Error(`provider readiness check failed after ${maxAttempts} attempts`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await waitForProvider({
    url: process.env.PROVIDER_READINESS_URL,
    bearerToken: process.env.PROVIDER_BEARER_TOKEN,
    attempts: process.env.PROVIDER_READINESS_ATTEMPTS,
    intervalMs: process.env.PROVIDER_READINESS_INTERVAL_MS,
    timeoutMs: process.env.PROVIDER_READINESS_TIMEOUT_MS,
  });
  console.log(`[provider-readiness] ready after ${result.attempts} attempt(s)`);
}
