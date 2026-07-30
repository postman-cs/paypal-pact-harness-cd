const KINDS = new Set(['missing', 'rogue']);
const METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']);

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Validate an approved route mismatch register and reject expired/broad entries. */
export function validateRouteExceptions(register, { environment, now = new Date() } = {}) {
  const records = Array.isArray(register) ? register : register?.exceptions;
  const interactions = [];
  if (!Array.isArray(records)) {
    interactions.push({
      description: 'route exception register shape',
      ok: false,
      failures: [{ check: 'exception-register-shape', detail: 'register must be an array or an object with an exceptions array' }],
      fields: [],
    });
  } else {
    const seen = new Set();
    records.forEach((record, index) => {
      const failures = [];
      const label = `${record?.kind ?? 'unknown'} ${record?.method ?? '?'} ${record?.path ?? `#${index}`}`;
      if (!KINDS.has(record?.kind)) failures.push({ check: 'exception-kind', detail: 'kind must be missing or rogue' });
      if (!METHODS.has(String(record?.method ?? '').toUpperCase())) failures.push({ check: 'exception-method', detail: 'method must be an HTTP method' });
      if (typeof record?.path !== 'string' || !record.path.startsWith('/')) failures.push({ check: 'exception-path', detail: 'path must start with /' });
      if (typeof record?.reason !== 'string' || record.reason.trim().length < 12) failures.push({ check: 'exception-reason', detail: 'reason must contain at least 12 characters' });
      if (typeof record?.ticket !== 'string' || record.ticket.trim().length < 3) failures.push({ check: 'exception-ticket', detail: 'ticket is required' });
      if (typeof record?.approvedBy !== 'string' || record.approvedBy.trim().length < 3) failures.push({ check: 'exception-approver', detail: 'approvedBy is required' });
      if (!validDate(record?.approvedAt) || Date.parse(record.approvedAt) > now.getTime()) failures.push({ check: 'exception-approved-at', detail: 'approvedAt must be a valid past timestamp' });
      if (!validDate(record?.expiresAt) || Date.parse(record.expiresAt) <= now.getTime()) failures.push({ check: 'exception-expired', detail: 'expiresAt must be a valid future timestamp' });
      if (!Array.isArray(record?.environments) || record.environments.length === 0) failures.push({ check: 'exception-environments', detail: 'at least one environment is required' });
      if (environment && !record?.environments?.includes(environment)) failures.push({ check: 'exception-environment-scope', detail: `exception is not approved for environment '${environment}'` });
      const key = `${record?.kind}:${String(record?.method).toUpperCase()}:${record?.path}`;
      if (seen.has(key)) failures.push({ check: 'exception-duplicate', detail: `duplicate exception '${key}'` });
      seen.add(key);
      interactions.push({ description: label, ok: failures.length === 0, failures, fields: [] });
    });
  }
  const failed = interactions.filter((interaction) => !interaction.ok).length;
  return {
    consumer: 'route-exceptions',
    provider: environment ?? 'all-environments',
    ok: failed === 0,
    summary: { total: interactions.length, passed: interactions.length - failed, failed },
    interactions,
    exceptions: Array.isArray(records) ? records : [],
  };
}
