import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  assertDedicatedSubtreePath,
  resolveDedicatedSubtreePath,
} from './lib/path-safety.mjs';

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'environment',
  'provider',
  'consumer',
  'application',
  'policy',
  'reports',
  'postman',
]);
const SECTION_KEYS = {
  provider: new Set(['name', 'oas', 'baseline']),
  consumer: new Set(['format', 'contract']),
  application: new Set([
    'routes',
    'actuatorUrl',
    'generatedOpenApiUrl',
    'gatewayInventoryUrl',
    'runtimeTrafficUrl',
    'stripPrefix',
  ]),
  policy: new Set(['subset', 'contract', 'exceptions', 'route', 'completeResults']),
  reports: new Set(['directory']),
  postman: new Set(['enabled', 'collection', 'baseUrl', 'cloud', 'workspaceId', 'collectionSha256']),
};

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function onlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.sort().join(', ')}`);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} contains forbidden control characters`);
  return value.trim();
}

function optionalText(value, label) {
  if (value === undefined || value === null || value === '') return '';
  return requiredText(value, label);
}

function boolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false`);
  return value;
}

function confinedPath(root, value, label, { required = true, mustExist = true } = {}) {
  const input = required ? requiredText(value, label) : optionalText(value, label);
  if (!input) return '';
  if (isAbsolute(input)) throw new Error(`${label} must be repository-relative`);
  const target = resolve(root, input);
  const rel = relative(root, target);
  if (!rel || rel === '.') {
    if (label !== 'reports.directory') throw new Error(`${label} must name a file inside the repository`);
  } else if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the repository root`);
  }
  if (mustExist && !existsSync(target)) throw new Error(`${label} does not exist: ${input}`);
  const rootReal = realpathSync(root);
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const real = realpathSync(existing);
  const realRel = relative(rootReal, real);
  if (realRel === '..' || realRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realRel)) {
    throw new Error(`${label} resolves outside the repository root`);
  }
  return { input, absolute: target };
}

export function assertSafeReportDirectory(root, target) {
  return assertDedicatedSubtreePath({
    root,
    target,
    subtree: '.contract-reports',
    label: 'reports.directory',
  });
}

function reportDirectory(root, value) {
  const input = requiredText(value, 'reports.directory');
  const absolute = resolveDedicatedSubtreePath({
    root,
    input,
    subtree: '.contract-reports',
    label: 'reports.directory',
  });
  return { input, absolute };
}

function httpUrl(value, label) {
  const input = optionalText(value, label);
  if (!input) return '';
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} must be an absolute http(s) URL without embedded credentials`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function envOverride(env, name, fallback = '') {
  return typeof env[name] === 'string' && env[name].trim() ? env[name].trim() : fallback;
}

export function parseTpeConfig(text, label = 'contract gate config') {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
  return record(parsed, label);
}

export function loadTpeConfig(configPath, options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const env = options.env ?? process.env;
  const configFile = confinedPath(root, configPath, 'config', { mustExist: true });
  const raw = parseTpeConfig(readFileSync(configFile.absolute, 'utf8'), configFile.input);
  return validateTpeConfig(raw, { root, env, configPath: configFile.input });
}

export function validateTpeConfig(value, {
  root = process.cwd(),
  env = process.env,
  configPath = 'paypal-contract-gate.config.json',
} = {}) {
  const raw = record(value, 'contract gate config');
  onlyKeys(raw, TOP_LEVEL_KEYS, 'contract gate config');
  if (raw.schemaVersion !== 1) throw new Error('schemaVersion must be 1');

  const environment = requiredText(raw.environment, 'environment');
  if (environment !== 'lower') {
    throw new Error('the first PayPal TPE validation is locked to environment=lower');
  }

  const provider = record(raw.provider, 'provider');
  const consumer = record(raw.consumer, 'consumer');
  const application = record(raw.application, 'application');
  const policy = record(raw.policy, 'policy');
  const reports = record(raw.reports, 'reports');
  const postman = record(raw.postman ?? {}, 'postman');
  for (const [label, section] of Object.entries({ provider, consumer, application, policy, reports, postman })) {
    onlyKeys(section, SECTION_KEYS[label], label);
  }

  const providerName = requiredText(provider.name, 'provider.name');
  const providerOas = confinedPath(root, provider.oas, 'provider.oas');
  const baseline = confinedPath(root, provider.baseline, 'provider.baseline', {
    required: false,
    mustExist: true,
  });
  const consumerFormat = requiredText(consumer.format, 'consumer.format');
  if (!['pact', 'oas', 'postman'].includes(consumerFormat)) {
    throw new Error('consumer.format must be pact, oas, or postman');
  }
  const consumerContract = confinedPath(root, consumer.contract, 'consumer.contract');
  const subset = confinedPath(root, policy.subset, 'policy.subset');
  const contractPolicy = confinedPath(root, policy.contract, 'policy.contract');
  const exceptions = confinedPath(root, policy.exceptions, 'policy.exceptions');
  const routePolicy = optionalText(policy.route, 'policy.route') || 'block';
  if (!['block', 'warn'].includes(routePolicy)) throw new Error('policy.route must be block or warn');
  const completeResults = boolean(policy.completeResults, 'policy.completeResults', true);
  const reportDirectoryPath = reportDirectory(root, reports.directory);

  const actuatorUrl = httpUrl(
    envOverride(env, 'PAYPAL_CONTRACT_ACTUATOR_URL', application.actuatorUrl),
    'application.actuatorUrl',
  );
  const generatedOpenApiUrl = httpUrl(
    envOverride(env, 'PAYPAL_CONTRACT_OPENAPI_URL', application.generatedOpenApiUrl),
    'application.generatedOpenApiUrl',
  );
  const gatewayInventoryUrl = httpUrl(
    envOverride(env, 'PAYPAL_CONTRACT_GATEWAY_URL', application.gatewayInventoryUrl),
    'application.gatewayInventoryUrl',
  );
  const runtimeTrafficUrl = httpUrl(
    envOverride(env, 'PAYPAL_CONTRACT_TRAFFIC_URL', application.runtimeTrafficUrl),
    'application.runtimeTrafficUrl',
  );
  if (Boolean(actuatorUrl) !== Boolean(generatedOpenApiUrl)) {
    throw new Error('application.actuatorUrl and application.generatedOpenApiUrl must be supplied together');
  }
  if ((gatewayInventoryUrl || runtimeTrafficUrl) && !actuatorUrl) {
    throw new Error('optional gateway/runtime traffic inventories require the Actuator and generated OpenAPI pair');
  }
  const routes = confinedPath(root, application.routes, 'application.routes', {
    required: false,
    mustExist: !actuatorUrl,
  });
  if (!actuatorUrl && !routes) {
    throw new Error('supply application.routes or the Actuator/generated OpenAPI URL pair');
  }

  const postmanEnabled = boolean(postman.enabled, 'postman.enabled', false);
  const postmanCollection = envOverride(env, 'PAYPAL_CONTRACT_POSTMAN_COLLECTION', postman.collection);
  const postmanBaseUrl = httpUrl(
    envOverride(env, 'PAYPAL_CONTRACT_APP_BASE_URL', postman.baseUrl),
    'postman.baseUrl',
  );
  const postmanCloud = boolean(postman.cloud, 'postman.cloud', false);
  const postmanWorkspaceId = envOverride(
    env,
    'PAYPAL_CONTRACT_POSTMAN_WORKSPACE_ID',
    postman.workspaceId,
  );
  const postmanCollectionSha256 = envOverride(
    env,
    'PAYPAL_CONTRACT_POSTMAN_COLLECTION_SHA256',
    postman.collectionSha256,
  );
  if (postmanEnabled && !optionalText(postmanCollection, 'postman.collection')) {
    throw new Error('postman.collection is required when postman.enabled=true');
  }
  if (postmanEnabled && !postmanBaseUrl) {
    throw new Error('postman.baseUrl is required when postman.enabled=true');
  }
  if (postmanEnabled && postmanCloud) {
    if (!/^[A-Za-z0-9_-]{3,200}$/.test(postmanWorkspaceId ?? '')) {
      throw new Error('postman.workspaceId is required when postman.cloud=true');
    }
    if (!/^[a-f0-9]{64}$/.test(postmanCollectionSha256 ?? '')) {
      throw new Error('postman.collectionSha256 is required when postman.cloud=true');
    }
  }

  return {
    schemaVersion: 1,
    configPath,
    root: resolve(root),
    environment,
    provider: {
      name: providerName,
      oas: providerOas,
      baseline,
    },
    consumer: {
      format: consumerFormat,
      contract: consumerContract,
    },
    application: {
      routes,
      actuatorUrl,
      generatedOpenApiUrl,
      gatewayInventoryUrl,
      runtimeTrafficUrl,
      stripPrefix: optionalText(application.stripPrefix, 'application.stripPrefix'),
    },
    policy: {
      subset,
      contract: contractPolicy,
      exceptions,
      route: routePolicy,
      completeResults,
    },
    reports: {
      directory: reportDirectoryPath,
    },
    postman: {
      enabled: postmanEnabled,
      collection: optionalText(postmanCollection, 'postman.collection'),
      baseUrl: postmanBaseUrl,
      cloud: postmanCloud,
      workspaceId: optionalText(postmanWorkspaceId, 'postman.workspaceId'),
      collectionSha256: optionalText(postmanCollectionSha256, 'postman.collectionSha256'),
    },
  };
}
