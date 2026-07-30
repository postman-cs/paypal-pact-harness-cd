// Provider side of Bi-Directional Contracts — "the provider supplies their end."
// The provider publishes their OAS as a PROVIDER CONTRACT and asks: can I ship this
// version without breaking ANY consumer? We cross-verify the provider's contract
// against every consumer pact (reusing bdc-verify) and aggregate into one verdict —
// the provider-side gate, the mirror of the consumer-side can-i-deploy.
//
// This is what turns the demo two-sided: consumers publish pacts, the PROVIDER
// publishes its OAS, and either side can gate on the other.

import { bdcVerify, canIDeploy } from './bdc-verify.mjs';

/** A stable, deterministic FNV-1a hash of the provider contract (its OAS). */
function digest(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Describe the provider contract the provider is supplying (their OAS + identity).
 * @param {object} oas
 * @param {{ name?: string, version?: string }} [meta]
 */
export function providerContract(oas, meta = {}) {
  const title = oas?.info?.title ?? 'provider';
  const paths = oas?.paths ?? {};
  let operations = 0;
  for (const p of Object.keys(paths)) {
    for (const m of Object.keys(paths[p] ?? {})) {
      if (['get', 'put', 'post', 'delete', 'patch', 'head', 'options'].includes(m)) operations++;
    }
  }
  return {
    provider: meta.name ?? title,
    version: meta.version ?? oas?.info?.version ?? 'unknown',
    title,
    operations,
    contentHash: digest(JSON.stringify(oas ?? {})),
  };
}

/**
 * Verify the provider's supplied contract (OAS) against every consumer pact.
 * @param {object} oas
 * @param {ReadonlyArray<{ consumer: string, pact: object }>} consumerPacts
 * @param {{ name?: string, version?: string }} [meta]
 */
export function providerVerify(oas, consumerPacts, meta = {}) {
  const contract = providerContract(oas, meta);
  const perConsumer = consumerPacts.map(({ consumer, pact }) => {
    const result = bdcVerify(oas, pact);
    const verdict = canIDeploy(result);
    return { consumer, deployable: verdict.deployable, reasons: verdict.reasons, result };
  });
  const deployable = perConsumer.every((c) => c.deployable);
  const reasons = perConsumer.flatMap((c) => c.reasons.map((r) => `${c.consumer}: ${r}`));
  const total = perConsumer.reduce((n, c) => n + c.result.summary.total, 0);
  const passed = perConsumer.reduce((n, c) => n + c.result.summary.passed, 0);
  return {
    contract,
    provider: contract.provider,
    deployable,
    reasons,
    perConsumer: perConsumer.map((c) => ({ consumer: c.consumer, deployable: c.deployable, reasons: c.reasons })),
    summary: { consumers: perConsumer.length, total, passed, failed: total - passed },
  };
}
