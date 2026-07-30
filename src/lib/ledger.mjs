// Git-backed contract ledger — the cross-fleet can-i-deploy authority as pure
// computation over committed files (Decision D12). No box, no server: the durable
// store is git; recording is a file write + commit; `can-i-deploy` is a PURE read
// over the ledger snapshot.
//
// This module is pure (no fs, no clock, no network) so it is unit-testable and
// browser/edge-safe, exactly like pact.mjs / oas.mjs / bdc-verify.mjs. The fs
// projection lives in ../ledger-store.mjs; the serialized git write in ./git-retry.mjs.
//
// Ledger layout (all LF, 2-space JSON, deterministic key order):
//   pacts/<consumer>@<cver>/<provider>.json         the consumer contract
//   providers/<provider>@<pver>.json                provider contract summary (hash, ops)
//   verifications/<consumer>@<cver>--<provider>@<pver>.json   { ok, at, reasons }
//   environments/<env>/<pacticipant>.json           { version, at }  ← the mutable bit

/** Make a version/name safe for a path segment (shas, semvers, slugs pass through). */
export function safeSeg(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_');
}

export const ledgerPaths = {
  pact: (consumer, cver, provider) => `pacts/${safeSeg(consumer)}@${safeSeg(cver)}/${safeSeg(provider)}.json`,
  provider: (provider, pver) => `providers/${safeSeg(provider)}@${safeSeg(pver)}.json`,
  verification: (consumer, cver, provider, pver) =>
    `verifications/${safeSeg(consumer)}@${safeSeg(cver)}--${safeSeg(provider)}@${safeSeg(pver)}.json`,
  environment: (env, pacticipant) => `environments/${safeSeg(env)}/${safeSeg(pacticipant)}.json`,
};

// ── record builders (deterministic shapes; `at` is injected at the edge) ──

export function buildPactRecord(pact, { consumerVersion }) {
  return { consumer: pact.consumer.name, consumerVersion, provider: pact.provider.name, pact };
}

export function buildProviderRecord({ provider, providerVersion, contentHash = null, operations = null }) {
  return { provider, providerVersion, contentHash, operations };
}

export function buildVerificationRecord({ consumer, consumerVersion, provider, providerVersion, ok, at = null, reasons = [] }) {
  return { consumer, consumerVersion, provider, providerVersion, ok: Boolean(ok), at, reasons };
}

export function buildDeploymentRecord({ pacticipant, version, environment, at = null }) {
  return { pacticipant, environment, version, at };
}

// ── the can-i-deploy computation (pure) ──

/**
 * Snapshot: { verifications: VerificationRecord[], environments: { [env]: { [pacticipant]: { version } } } }
 * Query:    { pacticipant, version, environment }
 *
 * Deployability rule: a candidate version is deployable to an environment iff, for
 * every integration partner CURRENTLY DEPLOYED in that environment, a passing
 * verification exists between the candidate version and the partner's deployed
 * version. Partners not deployed in the environment impose no constraint.
 */
export function canIDeployLedger(snapshot, { pacticipant, version, environment }) {
  const verifs = snapshot.verifications || [];
  const deployedInEnv = (snapshot.environments && snapshot.environments[environment]) || {};

  // Partners of this pacticipant, and OUR role in each integration.
  const partners = [];
  const seen = new Set();
  for (const v of verifs) {
    if (v.consumer === pacticipant && !seen.has('P:' + v.provider)) {
      seen.add('P:' + v.provider);
      partners.push({ partner: v.provider, role: 'consumer' });
    }
    if (v.provider === pacticipant && !seen.has('C:' + v.consumer)) {
      seen.add('C:' + v.consumer);
      partners.push({ partner: v.consumer, role: 'provider' });
    }
  }

  const matrix = [];
  const reasons = [];
  for (const { partner, role } of partners) {
    const dep = deployedInEnv[partner];
    if (!dep) {
      matrix.push({ partner, deployed: null, ok: true, note: `not deployed in ${environment}` });
      continue;
    }
    const partnerVersion = dep.version;
    const match = verifs.find((v) =>
      role === 'consumer'
        ? v.consumer === pacticipant && v.consumerVersion === version && v.provider === partner && v.providerVersion === partnerVersion
        : v.provider === pacticipant && v.providerVersion === version && v.consumer === partner && v.consumerVersion === partnerVersion,
    );
    const ok = Boolean(match && match.ok);
    matrix.push({ partner, deployed: partnerVersion, verified: match ? match.ok : null, ok });
    if (!match) reasons.push(`no verification between ${pacticipant}@${version} and ${partner}@${partnerVersion} (deployed in ${environment})`);
    else if (!match.ok) reasons.push(`verification FAILED between ${pacticipant}@${version} and ${partner}@${partnerVersion}`);
  }

  return {
    pacticipant, version, environment,
    deployable: reasons.length === 0,
    reasons,
    matrix,
    partnersConsidered: partners.length,
  };
}

/** Apply a deployment to an environments map, returning a NEW map (pure). */
export function applyDeployment(environments, { environment, pacticipant, version, at = null }) {
  const next = structuredClone(environments || {});
  next[environment] = next[environment] || {};
  next[environment][pacticipant] = { version, at };
  return next;
}
