#!/usr/bin/env node
// pact-harness CLI. Pure orchestration over the transformer + cross-verifier.
// Postman-native IO (fetching the collection / OAS) is the Postman CLI's job
// (Decision D9) — these commands consume the artifacts it produces.
//
//   pact-harness postman-to-pact --collection c.json --provider paypal-orders [--consumer app] [--out pact.json]
//   pact-harness oas-to-pact     --oas consumer.json --provider paypal-orders [--consumer app] [--out pact.json]
//   pact-harness bdc-verify      --oas oas.yaml --pact pact.json [--junit out.xml] [--json]
//   pact-harness can-i-deploy    --oas oas.yaml --pact pact.json           (single-pair static gate)
//   pact-harness can-i-deploy    --ledger DIR --pacticipant X --version v --to prod   (cross-fleet, git-backed)
//   pact-harness record-verification --ledger DIR --oas oas.yaml --pact pact.json --consumer-version cv --provider-version pv
//   pact-harness record-deployment   --ledger DIR --pacticipant X --version v --environment prod

import { writeFileSync } from 'node:fs';
import { loadDoc } from './lib/load.mjs';
import { serialize } from './lib/pact.mjs';
import { postmanToPact } from './postman-to-pact.mjs';
import { oasToPact } from './oas-to-pact.mjs';
import { bdcVerify, canIDeploy } from './bdc-verify.mjs';
import { auditOas } from './oas-audit.mjs';
import { diffOas } from './oas-diff.mjs';
import { validateRouteExceptions } from './route-exceptions.mjs';
import { providerVerify, providerContract } from './provider-verify.mjs';
import { canIDeployLedger, buildPactRecord, buildProviderRecord, buildVerificationRecord, buildDeploymentRecord } from './lib/ledger.mjs';
import { readLedger, writePactRecord, writeProviderRecord, writeVerificationRecord, writeDeploymentRecord } from './ledger-store.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Render a bdcVerify result as a JUnit report (what the Harness gate declares). */
export function toJUnit(result) {
  const failures = result.summary.failed;
  const cases = result.interactions.map((i) => {
    const name = xmlEscape(i.description);
    const classname = xmlEscape(`${result.consumer}.${result.provider}`);
    if (i.ok) return `    <testcase name="${name}" classname="${classname}"/>`;
    const msg = xmlEscape(i.failures.map((f) => f.check).join(', '));
    const detail = xmlEscape(i.failures.map((f) => `${f.check}: ${f.detail}`).join('\n'));
    return `    <testcase name="${name}" classname="${classname}">\n      <failure message="${msg}">${detail}</failure>\n    </testcase>`;
  });
  const suiteName = xmlEscape(`${result.consumer} -> ${result.provider}`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="bdc-verify" tests="${result.summary.total}" failures="${failures}">`,
    `  <testsuite name="${suiteName}" tests="${result.summary.total}" failures="${failures}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

function need(args, key) {
  if (!args[key] || args[key] === true) {
    console.error(`error: --${key} is required`);
    process.exit(2);
  }
  return args[key];
}

function cmdPostmanToPact(args) {
  const collection = loadDoc(need(args, 'collection'));
  const pact = postmanToPact(collection, {
    provider: need(args, 'provider'),
    consumer: typeof args.consumer === 'string' ? args.consumer : undefined,
    includeVolatileHeaders: args['include-volatile-headers'] === true,
  });
  const text = serialize(pact);
  if (typeof args.out === 'string') {
    writeFileSync(args.out, text);
    console.log(`wrote ${args.out} (${pact.interactions.length} interaction(s))`);
  } else {
    process.stdout.write(text);
  }
}

function cmdOasToPact(args) {
  const oas = loadDoc(need(args, 'oas'));
  const pact = oasToPact(oas, {
    provider: need(args, 'provider'),
    consumer: typeof args.consumer === 'string' ? args.consumer : undefined,
  });
  const text = serialize(pact);
  if (typeof args.out === 'string') {
    writeFileSync(args.out, text);
    console.log(`wrote ${args.out} (${pact.interactions.length} interaction(s))`);
  } else {
    process.stdout.write(text);
  }
}

function reportResult(result, args, { asGate }) {
  if (typeof args.junit === 'string') {
    writeFileSync(args.junit, toJUnit(result));
    console.log(`wrote JUnit -> ${args.junit}`);
  }
  const jsonResult = asGate ? { ...canIDeploy(result), result } : result;
  if (typeof args['json-out'] === 'string') {
    writeFileSync(args['json-out'], JSON.stringify(jsonResult, null, 2) + '\n');
    console.log(`wrote JSON -> ${args['json-out']}`);
  }
  if (args.json === true) {
    process.stdout.write(JSON.stringify(jsonResult, null, 2) + '\n');
  } else {
    console.log(`${result.consumer} -> ${result.provider}: ${result.summary.passed}/${result.summary.total} interactions verified`);
    for (const i of result.interactions) {
      if (i.ok) continue;
      console.log(`  ✗ ${i.description}`);
      for (const f of i.failures) console.log(`      - ${f.check}: ${f.detail}`);
    }
    if (asGate) {
      console.log(`[DEMO] static compatibility: ${result.ok ? 'PASS' : 'FAIL'}`);
      console.log('This is not a Pact Broker can-i-deploy decision.');
    }
  }
  process.exit(result.ok ? 0 : 1);
}

// Static BDC: consumer pact x provider OAS (no provider run).
function cmdBdcVerify(args, { asGate }) {
  const policyDoc = typeof args.policy === 'string' ? loadDoc(args.policy) : {};
  const result = bdcVerify(
    loadDoc(need(args, 'oas')),
    loadDoc(need(args, 'pact')),
    policyDoc.consumer ?? policyDoc,
  );
  reportResult(result, args, { asGate });
}

function cmdOasAudit(args) {
  const policyDoc = typeof args.policy === 'string' ? loadDoc(args.policy) : {};
  const result = auditOas(loadDoc(need(args, 'oas')), {
    subset: typeof args.subset === 'string' ? loadDoc(args.subset) : null,
    policy: policyDoc.oasAudit ?? policyDoc,
  });
  reportResult(result, args, { asGate: false });
}

function cmdOasDiff(args) {
  const result = diffOas(loadDoc(need(args, 'baseline')), loadDoc(need(args, 'candidate')), {
    subset: typeof args.subset === 'string' ? loadDoc(args.subset) : null,
  });
  reportResult(result, args, { asGate: false });
}

function cmdValidateExceptions(args) {
  const result = validateRouteExceptions(loadDoc(need(args, 'file')), {
    environment: need(args, 'environment'),
  });
  reportResult(result, args, { asGate: false });
}

// can-i-deploy: ledger mode (--ledger, git-backed cross-fleet), else single-pair
// static BDC (--oas).
function cmdCanIDeploy(args) {
  if (typeof args.ledger === 'string') {
    const v = canIDeployLedger(readLedger(args.ledger), {
      pacticipant: need(args, 'pacticipant'),
      version: need(args, 'version'),
      environment: need(args, 'to'),
    });
    if (args.json === true) {
      process.stdout.write(JSON.stringify(v, null, 2) + '\n');
    } else {
      console.log(`can-i-deploy ${v.pacticipant}@${v.version} --to ${v.environment}: ${v.deployable ? 'YES' : 'NO'} (${v.partnersConsidered} partner integration(s))`);
      for (const m of v.matrix) {
        console.log(`  ${m.ok ? '✓' : '✗'} ${m.partner}${m.deployed ? '@' + m.deployed : ''}${m.note ? ' — ' + m.note : ''}`);
      }
      for (const r of v.reasons) console.log(`      - ${r}`);
    }
    process.exit(v.deployable ? 0 : 1);
  }
  cmdBdcVerify(args, { asGate: true });
}

// Provider side: the provider supplies its OAS; verify it across all consumer pacts.
function cmdProviderVerify(args) {
  const provider = need(args, 'provider');
  const oas = loadDoc(need(args, 'oas'));
  const files = String(need(args, 'consumers')).split(',').map((s) => s.trim()).filter(Boolean);
  const consumerPacts = files.map((f) => {
    const pact = postmanToPact(loadDoc(f), { provider });
    return { consumer: pact.consumer.name, pact };
  });
  const pv = providerVerify(oas, consumerPacts, { name: provider });
  if (args.json === true) {
    process.stdout.write(JSON.stringify(pv, null, 2) + '\n');
  } else {
    console.log(`provider ${pv.provider} (contract ${pv.contract.contentHash}, ${pv.contract.operations} ops) vs ${pv.summary.consumers} consumer(s):`);
    for (const c of pv.perConsumer) {
      console.log(`  ${c.deployable ? '✓' : '✗'} ${c.consumer}`);
      for (const r of c.reasons) console.log(`      - ${r}`);
    }
    console.log(`[DEMO] static provider compatibility: ${pv.deployable ? 'PASS' : 'FAIL'}`);
    console.log('This is not a Pact Broker can-i-deploy decision.');
  }
  process.exit(pv.deployable ? 0 : 1);
}

// Record a verification into the git-backed ledger (D12). Runs the static BDC
// cross-check and persists pact + provider + verification records. This is a WRITE
// to the contract ledger (a separate git repo), never to PayPal's source; it is not
// itself the gate — can-i-deploy is.
function cmdRecordVerification(args) {
  const dir = need(args, 'ledger');
  const oas = loadDoc(need(args, 'oas'));
  const pact = loadDoc(need(args, 'pact'));
  const policyDoc = typeof args.policy === 'string' ? loadDoc(args.policy) : {};
  const consumerVersion = need(args, 'consumer-version');
  const providerVersion = need(args, 'provider-version');
  const result = bdcVerify(oas, pact, policyDoc.consumer ?? policyDoc);
  const pc = providerContract(oas, { name: pact.provider.name });
  const at = new Date().toISOString();

  writePactRecord(dir, buildPactRecord(pact, { consumerVersion }));
  writeProviderRecord(dir, buildProviderRecord({ provider: pact.provider.name, providerVersion, contentHash: pc.contentHash, operations: pc.operations }));
  writeVerificationRecord(dir, buildVerificationRecord({
    consumer: pact.consumer.name, consumerVersion,
    provider: pact.provider.name, providerVersion,
    ok: result.ok, at, reasons: canIDeploy(result).reasons,
  }));
  console.log(`recorded ${pact.consumer.name}@${consumerVersion} × ${pact.provider.name}@${providerVersion}: ${result.ok ? 'PASS' : 'FAIL'} -> ${dir}`);
  // Exit 0 on a successful WRITE regardless of pass/fail — the blocking decision is
  // can-i-deploy --to <env>, so a failing verification is still recorded (and blocks).
}

// Record a deployment/release into the ledger: "version v of X is now live in <env>".
// The one mutable, shared record; PayPal calls this from its own promotion step.
function cmdRecordDeployment(args) {
  const dir = need(args, 'ledger');
  const rec = buildDeploymentRecord({
    pacticipant: need(args, 'pacticipant'),
    version: need(args, 'version'),
    environment: need(args, 'environment'),
    at: new Date().toISOString(),
  });
  writeDeploymentRecord(dir, rec);
  console.log(`recorded deployment ${rec.pacticipant}@${rec.version} -> ${rec.environment} (${dir})`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
switch (cmd) {
  case 'postman-to-pact': cmdPostmanToPact(args); break;
  case 'oas-to-pact': cmdOasToPact(args); break;
  case 'bdc-verify': cmdBdcVerify(args, { asGate: false }); break;
  case 'oas-audit': cmdOasAudit(args); break;
  case 'oas-diff': cmdOasDiff(args); break;
  case 'validate-exceptions': cmdValidateExceptions(args); break;
  case 'provider-verify': cmdProviderVerify(args); break;
  case 'record-verification': cmdRecordVerification(args); break;
  case 'record-deployment': cmdRecordDeployment(args); break;
  case 'can-i-deploy': cmdCanIDeploy(args); break;
  default:
    console.error('usage: pact-harness <postman-to-pact|oas-to-pact|oas-audit|oas-diff|validate-exceptions|bdc-verify|provider-verify|record-verification|record-deployment|can-i-deploy> [options]');
    process.exit(2);
}
