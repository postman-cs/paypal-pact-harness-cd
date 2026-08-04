import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 10_000;

function brokerUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error('PACT_BROKER_BASE_URL is required');
  const parsed = new URL(value.endsWith('/') ? value : `${value}/`);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Pact Broker URL must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Pact Broker credentials must not be embedded in the URL');
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function authorizationHeader(username, password) {
  if (!username && !password) return undefined;
  if (!username || !password) throw new Error('Pact Broker username and password must be supplied together');
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export async function preflightPactBroker({
  baseUrl = process.env.PACT_BROKER_BASE_URL,
  username = process.env.PACT_BROKER_USERNAME,
  password = process.env.PACT_BROKER_PASSWORD,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const base = brokerUrl(baseUrl);
  const authorization = authorizationHeader(username, password);
  const headers = { accept: 'application/hal+json' };
  if (authorization) headers.authorization = authorization;

  for (const relative of ['diagnostic/status/heartbeat', '']) {
    let response;
    try {
      response = await fetchImpl(new URL(relative, base), {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(`Pact Broker preflight could not reach ${relative || 'the authenticated root'}`);
    }
    if (!response.ok) {
      throw new Error(`Pact Broker preflight received HTTP ${response.status} from ${relative || 'the authenticated root'}`);
    }
  }
}

async function main() {
  try {
    await preflightPactBroker();
    console.log('Pact Broker heartbeat and authenticated root are reachable');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
